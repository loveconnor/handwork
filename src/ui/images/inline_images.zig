//! Inline image service for the interactive terminal.
//!
//! Transcript renderers ask this service to lay out an image inside a cell
//! box and receive text rows: Kitty placeholder cells for pixel protocols,
//! or colored half blocks for the text fallback. Decoded images are cached
//! for the session, so a source renders identically on every repaint.
//!
//! After each committed frame the service delivers pixels:
//! - kitty: transmits each image once (and again after a terminal reset);
//!   the terminal draws placeholder cells by itself.
//! - iterm2/sixel: the wire carries blanks instead of placeholders, and
//!   the service draws pixels over every placeholder run whose cells the
//!   shadow grid does not mark as already drawn.
//!
//! The service is installed only by the interactive app; when it is absent
//! (tests, headless runs, wasm) every entry point reports "not rendered"
//! and callers keep their text presentation.

const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../../core/shared/io.zig");
const debug_trace = @import("../../core/shared/debug_trace.zig");
const image_placeholder = @import("../../core/shared/image_placeholder.zig");
const raster_mod = @import("../../core/images/raster.zig");
const codecs = @import("../../core/images/codecs.zig");
const image_attachments = @import("../../core/images/image_attachments.zig");
const vector = @import("../../core/images/vector.zig");
const vt_emulator = @import("../../core/terminal/engine.zig");
const types = @import("../../core/shared/types.zig");
const terminal_diff = @import("../render_engine/terminal_diff.zig");
const detection = @import("../terminal/graphics/detection.zig");
const kitty = @import("../terminal/graphics/kitty.zig");
const iterm2 = @import("../terminal/graphics/iterm2.zig");
const sixel = @import("../terminal/graphics/sixel.zig");
const blocks = @import("../terminal/graphics/blocks.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;

pub const Protocol = detection.Protocol;
pub const CellSize = detection.CellSize;

/// Largest image file read from disk.
pub const max_file_bytes: usize = 20 * 1024 * 1024;
/// Decoded images are reduced to this longest side; no terminal box needs more.
const max_cached_side: u32 = 2560;
/// Per-instance caches (cell-box rasters, half-block text, encoded
/// overlays) kept for repaints; least recently used are dropped first.
const cache_budget_bytes: usize = 128 * 1024 * 1024;

pub const Source = union(enum) {
    /// Absolute path of an image file.
    file: []const u8,
    /// Encoded PNG, JPEG, GIF, or WebP bytes.
    encoded: []const u8,
    /// SVG markup.
    svg: []const u8,
    /// Mermaid diagram source.
    mermaid: []const u8,
};

/// Largest cell area an image may occupy. Images keep their aspect ratio
/// and are never enlarged beyond their natural pixel size (vector sources
/// excepted, which have no natural pixel density).
pub const Box = struct {
    max_cols: u16,
    max_rows: u16,
};

pub const Placement = struct {
    cols: u16,
    rows: u16,
};

pub const Capabilities = struct {
    protocol: Protocol = .none,
    /// Known only when the terminal reported it; otherwise layout uses an
    /// assumed aspect ratio (never for SIXEL, see detection.finalize).
    cell: CellSize = .{ .width_px = 0, .height_px = 0 },
    color_depth: blocks.ColorDepth = .truecolor,
    /// Diagram colors follow the terminal background.
    theme: vector.Theme = .dark,
    /// Matte for antialiased edges in SIXEL, which has no fractional alpha.
    background: [3]u8 = .{ 0, 0, 0 },
};

var installed: ?*Service = null;
var session_service: Service = undefined;

pub fn install(service: *Service) void {
    installed = service;
}

pub fn uninstall() void {
    installed = null;
}

/// Starts the process-wide service for an interactive session. A terminal
/// without image support leaves the service absent.
pub fn startSession(gpa: Allocator, caps: Capabilities) void {
    if (installed != null or caps.protocol == .none) return;
    session_service = Service.init(gpa, caps);
    install(&session_service);
}

/// Applies a new cell pixel size after a terminal resize.
pub fn setCellSize(cell: CellSize) void {
    const service = installed orelse return;
    service.setCellSize(cell);
}

pub fn cellSize() CellSize {
    const service = installed orelse return .{ .width_px = 0, .height_px = 0 };
    return service.caps.cell;
}

pub fn active() ?*Service {
    return installed;
}

pub fn setBackground(background: [3]u8) void {
    const service = installed orelse return;
    service.lock();
    defer service.unlock();
    if (std.mem.eql(u8, &service.caps.background, &background)) return;
    service.caps.background = background;
    // Pixel sources stay unchanged; only SIXEL's composited payload depends
    // on the terminal background.
    if (service.caps.protocol != .sixel) return;
    for (service.instances.items) |*instance| {
        if (instance.overlay) |overlay| {
            service.cached_bytes -= overlay.bytes.len;
            service.gpa.free(overlay.bytes);
            instance.overlay = null;
        }
    }
}

pub fn protocol() Protocol {
    const service = installed orelse return .none;
    return service.caps.protocol;
}

/// Whether frame bytes must have placeholder cells replaced by blanks
/// before they reach the terminal.
pub fn wireBlanksPlaceholders() bool {
    return protocol().drawsPixelsOutOfBand();
}

/// Lays out and writes `source` as text rows separated by `\n` (no
/// trailing newline), each prefixed by `line_prefix`. Returns null without
/// writing anything when images are unavailable or the source cannot be
/// decoded, so callers can fall back to their text presentation.
pub fn renderRows(alloc: Allocator, source: Source, box: Box, line_prefix: []const u8, out: *std.ArrayList(u8)) !?Placement {
    const service = installed orelse return null;
    return service.renderRows(alloc, source, box, line_prefix, out);
}

/// Reports whether `source` would render, decoding it if needed. Callers
/// use this to decide between an image block and their text fallback.
pub fn canRender(source: Source) bool {
    const service = installed orelse return false;
    return service.canRender(source);
}

/// A decoded source: pixels plus the size the source naturally displays
/// at (CSS pixels for vector sources, which render at higher density).
const Decoded = struct {
    image: Raster,
    natural_width: u32,
    natural_height: u32,
};

const DecodedEntry = union(enum) {
    ready: Decoded,
    failed,
};

const InstanceKey = struct {
    entry: u32,
    cols: u16,
    rows: u16,
};

const Instance = struct {
    entry: u32,
    cols: u16,
    rows: u16,
    /// The image fitted into the whole cell box at device pixels, with
    /// transparent padding; built on demand and evictable.
    box: ?Raster = null,
    kitty_transmitted: bool = false,
    /// Text rows for the half-block fallback.
    block_rows: ?[]u8 = null,
    /// Last encoded overlay (SIXEL or iTerm2 payload) and the image rows it
    /// covers; scrolling redraws the same crop repeatedly.
    overlay: ?OverlayPayload = null,
    last_used: u64 = 0,
};

const OverlayPayload = struct {
    image_row: u16,
    rows: u16,
    bytes: []u8,
};

fn cacheBytes(instance: Instance) usize {
    var total: usize = 0;
    if (instance.box) |box| total += box.pixels.len;
    if (instance.block_rows) |text| total += text.len;
    if (instance.overlay) |overlay| total += overlay.bytes.len;
    return total;
}

pub const Service = struct {
    gpa: Allocator,
    caps: Capabilities,
    mutex: std.Io.Mutex = .init,
    entries: std.ArrayList(DecodedEntry) = .empty,
    entry_index: std.StringHashMapUnmanaged(u32) = .empty,
    instances: std.ArrayList(Instance) = .empty,
    instance_index: std.AutoHashMapUnmanaged(InstanceKey, u32) = .empty,
    cached_bytes: usize = 0,
    cache_budget: usize = cache_budget_bytes,
    use_clock: u64 = 0,
    /// End of the last placeholder frame's synchronized update (and cursor
    /// show), held back so pixel overlays land in the same atomic update.
    deferred_tail: [16]u8 = undefined,
    deferred_tail_len: usize = 0,
    /// Set while overlays write, so their bytes bypass frame handling.
    writing_overlay: bool = false,

    pub fn init(gpa: Allocator, caps: Capabilities) Service {
        return .{ .gpa = gpa, .caps = caps };
    }

    pub fn deinit(self: *Service) void {
        for (self.entries.items) |*entry| switch (entry.*) {
            .ready => |*decoded| decoded.image.deinit(self.gpa),
            .failed => {},
        };
        self.entries.deinit(self.gpa);
        var keys = self.entry_index.keyIterator();
        while (keys.next()) |key| self.gpa.free(key.*);
        self.entry_index.deinit(self.gpa);
        for (self.instances.items) |*instance| self.dropInstanceCaches(instance);
        self.instances.deinit(self.gpa);
        self.instance_index.deinit(self.gpa);
        self.* = undefined;
    }

    pub fn setCellSize(self: *Service, cell: CellSize) void {
        if (!cell.isKnown()) return;
        self.lock();
        defer self.unlock();
        if (cell.width_px == self.caps.cell.width_px and cell.height_px == self.caps.cell.height_px) return;
        self.caps.cell = cell;
        // Every cache depends on the device pixel size; rebuild on demand.
        for (self.instances.items) |*instance| self.dropInstanceCaches(instance);
    }

    fn lock(self: *Service) void {
        self.mutex.lockUncancelable(io_mod.getIo());
    }

    fn unlock(self: *Service) void {
        self.mutex.unlock(io_mod.getIo());
    }

    pub fn canRender(self: *Service, source: Source) bool {
        if (self.caps.protocol == .none) return false;
        self.lock();
        defer self.unlock();
        const entry = self.entryFor(source) catch return false;
        return self.entries.items[entry] == .ready;
    }

    pub fn renderRows(self: *Service, alloc: Allocator, source: Source, box: Box, line_prefix: []const u8, out: *std.ArrayList(u8)) !?Placement {
        if (self.caps.protocol == .none or box.max_cols == 0 or box.max_rows == 0) return null;
        self.lock();
        defer self.unlock();
        const entry = self.entryFor(source) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
        };
        const decoded = switch (self.entries.items[entry]) {
            .ready => |decoded| decoded,
            .failed => return null,
        };
        const placement = layout(decoded.natural_width, decoded.natural_height, box, self.layoutCell());
        if (placement.cols == 0 or placement.rows == 0) return null;
        const id = try self.instanceFor(entry, placement);
        const instance = &self.instances.items[id - 1];

        var row: u16 = 0;
        if (self.caps.protocol == .blocks) {
            const text = try self.blockRows(instance);
            var lines = std.mem.splitScalar(u8, text, '\n');
            while (lines.next()) |line| : (row += 1) {
                if (row > 0) try out.append(alloc, '\n');
                try out.appendSlice(alloc, line_prefix);
                try out.appendSlice(alloc, line);
            }
            return placement;
        }

        var writer: std.Io.Writer.Allocating = .fromArrayList(alloc, out);
        defer out.* = writer.toArrayList();
        while (row < placement.rows) : (row += 1) {
            if (row > 0) try writer.writer.writeByte('\n');
            try writer.writer.writeAll(line_prefix);
            try image_placeholder.writeRow(&writer.writer, id, row, placement.cols);
        }
        return placement;
    }

    fn layoutCell(self: *const Service) CellSize {
        return if (self.caps.cell.isKnown()) self.caps.cell else CellSize.assumed;
    }

    fn entryFor(self: *Service, source: Source) Allocator.Error!u32 {
        var key_buf: [80]u8 = undefined;
        const key = sourceKey(source, &key_buf);
        if (self.entry_index.get(key)) |index| return index;

        const owned_key = try self.gpa.dupe(u8, key);
        errdefer self.gpa.free(owned_key);
        try self.entries.ensureUnusedCapacity(self.gpa, 1);
        try self.entry_index.ensureUnusedCapacity(self.gpa, 1);
        const decoded: DecodedEntry = if (loadDecoded(self.gpa, source, self.caps.theme)) |ready|
            .{ .ready = ready }
        else |err| blk: {
            if (err == error.OutOfMemory) return error.OutOfMemory;
            debug_trace.logf("images", "decode_failed kind={s} err={s}", .{ @tagName(source), @errorName(err) });
            break :blk .failed;
        };
        self.entries.appendAssumeCapacity(decoded);
        const index: u32 = @intCast(self.entries.items.len - 1);
        self.entry_index.putAssumeCapacity(owned_key, index);
        return index;
    }

    fn instanceFor(self: *Service, entry: u32, placement: Placement) !u32 {
        const key = InstanceKey{ .entry = entry, .cols = placement.cols, .rows = placement.rows };
        if (self.instance_index.get(key)) |id| {
            self.touch(&self.instances.items[id - 1]);
            return id;
        }
        if (self.instances.items.len >= image_placeholder.max_image_id) return error.ImageIdsExhausted;
        try self.instances.ensureUnusedCapacity(self.gpa, 1);
        try self.instance_index.ensureUnusedCapacity(self.gpa, 1);
        self.instances.appendAssumeCapacity(.{ .entry = entry, .cols = placement.cols, .rows = placement.rows });
        const id: u32 = @intCast(self.instances.items.len);
        self.instance_index.putAssumeCapacity(key, id);
        self.touch(&self.instances.items[id - 1]);
        return id;
    }

    fn touch(self: *Service, instance: *Instance) void {
        self.use_clock += 1;
        instance.last_used = self.use_clock;
    }

    fn boxPixels(self: *const Service, instance: Instance) struct { width: u32, height: u32 } {
        const cell = self.layoutCell();
        return .{
            .width = @as(u32, instance.cols) * cell.width_px,
            .height = @as(u32, instance.rows) * cell.height_px,
        };
    }

    /// Returns the image fitted into its cell box, building it on demand.
    fn boxRaster(self: *Service, instance: *Instance) !Raster {
        if (instance.box) |box| return box;
        const image = self.entries.items[instance.entry].ready.image;
        const size = self.boxPixels(instance.*);
        var box = try Raster.init(self.gpa, size.width, size.height);
        errdefer box.deinit(self.gpa);
        const fit = raster_mod.fitWithin(image.width, image.height, size.width, size.height, true);
        var scaled = try image.resize(self.gpa, fit.width, fit.height);
        defer scaled.deinit(self.gpa);
        var y: u32 = 0;
        while (y < scaled.height) : (y += 1) {
            @memcpy(box.row(y)[0 .. @as(usize, scaled.width) * 4], scaled.row(y));
        }
        instance.box = box;
        self.remember(instance, box.pixels.len);
        return box;
    }

    /// Accounts for `added` cache bytes on `owner` and evicts other
    /// instances' caches, oldest first, until back within budget.
    fn remember(self: *Service, owner: *Instance, added: usize) void {
        self.cached_bytes += added;
        while (self.cached_bytes > self.cache_budget) {
            var oldest: ?*Instance = null;
            for (self.instances.items) |*candidate| {
                if (candidate == owner or cacheBytes(candidate.*) == 0) continue;
                if (oldest == null or candidate.last_used < oldest.?.last_used) oldest = candidate;
            }
            self.dropInstanceCaches(oldest orelse return);
        }
    }

    fn blockRows(self: *Service, instance: *Instance) ![]const u8 {
        if (instance.block_rows) |text| return text;
        const image = self.entries.items[instance.entry].ready.image;
        // Each cell shows two stacked pixels; fit those inside the box so
        // the result keeps the source aspect ratio on screen.
        const cell = self.layoutCell();
        const pixel_aspect = @as(f64, @floatFromInt(cell.height_px)) / (2.0 * @as(f64, @floatFromInt(cell.width_px)));
        const target_w: u32 = instance.cols;
        const target_h: u32 = instance.rows * 2;
        const virtual_h = @as(f64, @floatFromInt(image.height)) / pixel_aspect;
        const fit = raster_mod.fitWithin(image.width, @max(1, @as(u32, @intFromFloat(@round(virtual_h)))), target_w, target_h, true);
        var scaled = try image.resize(self.gpa, fit.width, fit.height);
        defer scaled.deinit(self.gpa);
        var out: std.Io.Writer.Allocating = .init(self.gpa);
        defer out.deinit();
        try blocks.write(&out.writer, scaled, self.caps.color_depth, "");
        const text = try out.toOwnedSlice();
        instance.block_rows = text;
        self.remember(instance, text.len);
        return text;
    }

    fn dropInstanceCaches(self: *Service, instance: *Instance) void {
        self.cached_bytes -= cacheBytes(instance.*);
        if (instance.box) |*box| box.deinit(self.gpa);
        if (instance.block_rows) |text| self.gpa.free(text);
        if (instance.overlay) |overlay| self.gpa.free(overlay.bytes);
        instance.box = null;
        instance.block_rows = null;
        instance.overlay = null;
    }

    /// Writes one frame through `raw`, adding what the protocol needs on
    /// the wire: kitty transmits each image the frame shows before the
    /// frame (after it, when the frame resets the terminal and would
    /// discard earlier transmissions); iterm2/sixel receive blanks in
    /// place of placeholder cells. The result reports progress in terms of
    /// the original `bytes`.
    pub fn writeFrame(self: *Service, raw: terminal_diff.FrameSink, metrics: *types.Metrics, bytes: []const u8) terminal_diff.FrameSinkWriteResult {
        if (self.writing_overlay) return raw.write_frame(raw.ctx, metrics, bytes);
        if (self.flushDeferredTail(raw, metrics)) |err| {
            return .{ .partial = .{ .accepted_bytes = 0, .err = err } };
        }
        switch (self.caps.protocol) {
            .kitty => return self.writeKittyFrame(raw, metrics, bytes),
            .iterm2, .sixel => return self.writeBlankedFrame(raw, metrics, bytes),
            .blocks, .none => return raw.write_frame(raw.ctx, metrics, bytes),
        }
    }

    fn writeKittyFrame(self: *Service, raw: terminal_diff.FrameSink, metrics: *types.Metrics, bytes: []const u8) terminal_diff.FrameSinkWriteResult {
        if (std.mem.indexOf(u8, bytes, image_placeholder.utf8) == null and !resetsTerminal(bytes)) {
            return raw.write_frame(raw.ctx, metrics, bytes);
        }
        self.lock();
        defer self.unlock();
        var ids: std.ArrayList(u32) = .empty;
        defer ids.deinit(self.gpa);
        image_placeholder.collectWireImageIds(self.gpa, bytes, &ids) catch {};
        if (resetsTerminal(bytes)) {
            for (self.instances.items) |*instance| instance.kitty_transmitted = false;
            const result = raw.write_frame(raw.ctx, metrics, bytes);
            if (result == .complete) self.transmitPending(ids.items, raw, metrics);
            return result;
        }
        self.transmitPending(ids.items, raw, metrics);
        return raw.write_frame(raw.ctx, metrics, bytes);
    }

    fn transmitPending(self: *Service, ids: []const u32, raw: terminal_diff.FrameSink, metrics: *types.Metrics) void {
        for (ids) |id| {
            if (id == 0 or id > self.instances.items.len) continue;
            const instance = &self.instances.items[id - 1];
            if (instance.kitty_transmitted) continue;
            self.transmitKitty(id, instance, raw, metrics) catch |err| {
                debug_trace.logf("images", "kitty_transmit_failed id={d} err={s}", .{ id, @errorName(err) });
                continue;
            };
            instance.kitty_transmitted = true;
        }
    }

    fn writeBlankedFrame(self: *Service, raw: terminal_diff.FrameSink, metrics: *types.Metrics, bytes: []const u8) terminal_diff.FrameSinkWriteResult {
        if (std.mem.indexOf(u8, bytes, image_placeholder.utf8) == null) return raw.write_frame(raw.ctx, metrics, bytes);
        var blanked: std.ArrayList(u8) = .empty;
        defer blanked.deinit(self.gpa);
        var replacements: std.ArrayList(image_placeholder.Replacement) = .empty;
        defer replacements.deinit(self.gpa);
        image_placeholder.blankClusters(self.gpa, bytes, &blanked, &replacements) catch |err| {
            return .{ .partial = .{ .accepted_bytes = 0, .err = err } };
        };
        const tail_len = synchronizedTailLength(blanked.items);
        const body = blanked.items[0 .. blanked.items.len - tail_len];
        return switch (raw.write_frame(raw.ctx, metrics, body)) {
            .complete => blk: {
                @memcpy(self.deferred_tail[0..tail_len], blanked.items[body.len..]);
                self.deferred_tail_len = tail_len;
                break :blk .complete;
            },
            .partial => |partial| .{ .partial = .{
                .accepted_bytes = image_placeholder.mapAcceptedOffset(replacements.items, partial.accepted_bytes),
                .err = partial.err,
            } },
        };
    }

    /// Draws pixels after a frame was committed, for protocols that place
    /// images out of band, then completes the frame's synchronized update.
    /// `shadow` is the committed terminal model.
    pub fn afterCommit(self: *Service, shadow: *vt_emulator.Grid, sink: terminal_diff.FrameSink, metrics: *types.Metrics) void {
        if (self.caps.protocol.drawsPixelsOutOfBand()) self.drawOverlays(shadow, sink, metrics);
        self.finishFrame(sink, metrics);
    }

    /// Writes any held-back frame tail. Called when a frame ends without a
    /// commit, and before every later write.
    pub fn finishFrame(self: *Service, sink: terminal_diff.FrameSink, metrics: *types.Metrics) void {
        if (self.deferred_tail_len == 0) return;
        self.writing_overlay = true;
        defer self.writing_overlay = false;
        _ = self.flushDeferredTail(sink, metrics);
    }

    fn flushDeferredTail(self: *Service, raw: terminal_diff.FrameSink, metrics: *types.Metrics) ?anyerror {
        if (self.deferred_tail_len == 0) return null;
        const tail = self.deferred_tail[0..self.deferred_tail_len];
        switch (raw.write_frame(raw.ctx, metrics, tail)) {
            .complete => self.deferred_tail_len = 0,
            .partial => |partial| {
                // Retry the unwritten suffix before allowing another frame.
                const remaining = tail[partial.accepted_bytes..];
                std.mem.copyForwards(u8, &self.deferred_tail, remaining);
                self.deferred_tail_len = remaining.len;
                return partial.err;
            },
        }
        return null;
    }

    fn transmitKitty(self: *Service, id: u32, instance: *Instance, sink: terminal_diff.FrameSink, metrics: *types.Metrics) !void {
        const box = try self.boxRaster(instance);
        const png = try codecs.png.encode(self.gpa, box);
        defer self.gpa.free(png);
        var out: std.Io.Writer.Allocating = .init(self.gpa);
        defer out.deinit();
        try kitty.writeTransmitPng(&out.writer, id, png, instance.cols, instance.rows);
        try writeOutOfBand(sink, metrics, out.written());
    }

    fn drawOverlays(self: *Service, shadow: *vt_emulator.Grid, sink: terminal_diff.FrameSink, metrics: *types.Metrics) void {
        self.lock();
        defer self.unlock();
        self.writing_overlay = true;
        defer self.writing_overlay = false;
        var runs = collectRuns(self.gpa, shadow, self) catch return;
        defer runs.deinit(self.gpa);
        for (runs.items) |run| {
            if (!run.needs_draw) continue;
            if (run.image_id == 0 or run.image_id > self.instances.items.len) continue;
            const instance = &self.instances.items[run.image_id - 1];
            // A run that touches the last screen row could scroll the screen
            // when the terminal advances the cursor past the image.
            var screen_rows = run.screen_row_count;
            if (run.screen_top + screen_rows - 1 >= shadow.rows) screen_rows -|= 1;
            if (screen_rows == 0) continue;
            self.drawRun(instance, run, screen_rows, sink, metrics) catch |err| {
                debug_trace.logf("images", "overlay_draw_failed id={d} err={s}", .{ run.image_id, @errorName(err) });
                continue;
            };
            markDrawn(shadow, run, screen_rows);
        }
    }

    /// Encoded pixels for image rows `[image_row, image_row + rows)`.
    fn overlayPayload(self: *Service, instance: *Instance, image_row: u16, rows: u16) ![]const u8 {
        if (instance.overlay) |cached| {
            if (cached.image_row == image_row and cached.rows == rows) return cached.bytes;
            self.cached_bytes -= cached.bytes.len;
            self.gpa.free(cached.bytes);
            instance.overlay = null;
        }
        const box = try self.boxRaster(instance);
        const cell = self.layoutCell();
        var crop = try box.cropRows(self.gpa, @as(u32, image_row) * cell.height_px, @as(u32, rows) * cell.height_px);
        defer crop.deinit(self.gpa);
        var out: std.Io.Writer.Allocating = .init(self.gpa);
        defer out.deinit();
        switch (self.caps.protocol) {
            .sixel => {
                crop.flattenEdgesOnto(self.caps.background);
                try sixel.encode(self.gpa, crop, &out.writer);
            },
            .iterm2 => {
                const png = try codecs.png.encode(self.gpa, crop);
                defer self.gpa.free(png);
                try iterm2.writeInlinePng(&out.writer, png, instance.cols, rows);
            },
            else => unreachable,
        }
        const bytes = try out.toOwnedSlice();
        instance.overlay = .{ .image_row = image_row, .rows = rows, .bytes = bytes };
        self.remember(instance, bytes.len);
        return bytes;
    }

    fn drawRun(self: *Service, instance: *Instance, run: Run, screen_rows: u16, sink: terminal_diff.FrameSink, metrics: *types.Metrics) !void {
        self.touch(instance);
        const payload = try self.overlayPayload(instance, run.image_row, screen_rows);

        var out: std.Io.Writer.Allocating = .init(self.gpa);
        defer out.deinit();
        const w = &out.writer;
        // Inside a held-back frame update the pixels join that update;
        // otherwise they get their own. DECSC/DECRC return the cursor to
        // where the frame left it.
        const own_update = self.deferred_tail_len == 0;
        if (own_update) try w.writeAll("\x1b[?2026h");
        try w.writeAll("\x1b7");
        try w.print("\x1b[{d};{d}H", .{ run.screen_top, run.screen_col });
        try w.writeAll(payload);
        try w.writeAll("\x1b8");
        if (own_update) try w.writeAll("\x1b[?2026l");
        try writeOutOfBand(sink, metrics, out.written());
    }
};

fn sourceKey(source: Source, buf: *[80]u8) []const u8 {
    const Sha256 = std.crypto.hash.sha2.Sha256;
    var digest: [Sha256.digest_length]u8 = undefined;
    const tag: u8 = switch (source) {
        .file => 'f',
        .encoded => 'e',
        .svg => 's',
        .mermaid => 'm',
    };
    switch (source) {
        .file => |path| Sha256.hash(path, &digest, .{}),
        inline .encoded, .svg, .mermaid => |bytes| Sha256.hash(bytes, &digest, .{}),
    }
    buf[0] = tag;
    buf[1] = ':';
    const hex = std.fmt.bytesToHex(digest, .lower);
    @memcpy(buf[2 .. 2 + hex.len], &hex);
    return buf[0 .. 2 + hex.len];
}

fn loadDecoded(alloc: Allocator, source: Source, theme: vector.Theme) !Decoded {
    return switch (source) {
        .file => |path| blk: {
            const bytes = try readImageFile(alloc, path);
            defer alloc.free(bytes);
            break :blk try decodeEncoded(alloc, bytes);
        },
        .encoded => |bytes| try decodeEncoded(alloc, bytes),
        .svg => |markup| fromVector(try vector.rasterizeSvg(alloc, markup)),
        .mermaid => |diagram| fromVector(try vector.rasterizeMermaid(alloc, diagram, theme)),
    };
}

fn fromVector(rendered: vector.Rendered) Decoded {
    return .{ .image = rendered.image, .natural_width = rendered.natural_width, .natural_height = rendered.natural_height };
}

/// Reads a regular file without following symlinks or blocking on
/// special files, so a path written by the model cannot stall the UI.
fn readImageFile(alloc: Allocator, path: []const u8) ![]u8 {
    var opened = try image_attachments.openVisionRegularFile(path);
    defer opened.close();
    var buffer: [16 * 1024]u8 = undefined;
    var reader = opened.file.reader(io_mod.getIo(), &buffer);
    return reader.interface.allocRemaining(alloc, .limited(max_file_bytes));
}

fn decodeEncoded(alloc: Allocator, bytes: []const u8) !Decoded {
    if (codecs.detect(bytes) == null) {
        // An .svg file is text; sniff it before giving up.
        if (vector.looksLikeSvg(bytes)) return fromVector(try vector.rasterizeSvg(alloc, bytes));
    }
    var image = try codecs.decode(alloc, bytes, .default);
    errdefer image.deinit(alloc);
    const natural_width = image.width;
    const natural_height = image.height;
    // Nothing on a terminal needs more pixels than this; keep memory bounded.
    if (image.width > max_cached_side or image.height > max_cached_side) {
        const fit = raster_mod.fitWithin(image.width, image.height, max_cached_side, max_cached_side, false);
        const smaller = try image.resize(alloc, fit.width, fit.height);
        image.deinit(alloc);
        image = smaller;
    }
    return .{ .image = image, .natural_width = natural_width, .natural_height = natural_height };
}

/// Cell footprint for an image whose natural size is `width` x `height`
/// pixels, shrunk (never enlarged) to fit `box`.
pub fn layout(width: u32, height: u32, box: Box, cell: CellSize) Placement {
    if (width == 0 or height == 0 or !cell.isKnown()) return .{ .cols = 0, .rows = 0 };
    const max_cols = @min(box.max_cols, image_placeholder.max_cells);
    const max_rows = @min(box.max_rows, image_placeholder.max_cells);
    const max_w = @as(u32, max_cols) * cell.width_px;
    const max_h = @as(u32, max_rows) * cell.height_px;
    const fit = raster_mod.fitWithin(width, height, max_w, max_h, false);
    const cols: u16 = @intCast(@min(max_cols, (fit.width + cell.width_px - 1) / cell.width_px));
    const rows: u16 = @intCast(@min(max_rows, (fit.height + cell.height_px - 1) / cell.height_px));
    return .{ .cols = @max(cols, 1), .rows = @max(rows, 1) };
}

/// Length of the frame-closing suffix: end of synchronized update,
/// optionally followed by showing the cursor. Zero when absent.
fn synchronizedTailLength(bytes: []const u8) usize {
    const end_sync = "\x1b[?2026l";
    const show_cursor = "\x1b[?25h";
    if (std.mem.endsWith(u8, bytes, end_sync)) return end_sync.len;
    if (std.mem.endsWith(u8, bytes, end_sync ++ show_cursor)) return end_sync.len + show_cursor.len;
    return 0;
}

/// RIS (`ESC c`) clears every image a kitty terminal holds.
fn resetsTerminal(bytes: []const u8) bool {
    return std.mem.indexOf(u8, bytes, "\x1bc") != null;
}

fn writeOutOfBand(sink: terminal_diff.FrameSink, metrics: *types.Metrics, bytes: []const u8) !void {
    switch (sink.write_frame(sink.ctx, metrics, bytes)) {
        .complete => {},
        .partial => |partial| {
            // A cut inside an APC/DCS/OSC string would swallow the next
            // frame; CAN aborts whatever sequence the terminal is parsing.
            _ = sink.write_frame(sink.ctx, metrics, "\x18\x1b\\");
            return partial.err;
        },
    }
}

/// A vertical run of complete placeholder rows of one image on screen.
const Run = struct {
    image_id: u32,
    /// First image row shown by the run.
    image_row: u16,
    /// One-based screen position of the run's first cell.
    screen_top: u16,
    screen_col: u16,
    screen_row_count: u16,
    needs_draw: bool,
};

/// Finds every on-screen run of rows that each show a complete row of
/// one image, in screen order. A row partly covered by other text breaks
/// the run so pixels are never drawn over it, and runs split where the
/// drawn state changes so intact pixels are not redrawn.
fn collectRuns(alloc: Allocator, shadow: *const vt_emulator.Grid, service: *const Service) !std.ArrayList(Run) {
    var runs: std.ArrayList(Run) = .empty;
    errdefer runs.deinit(alloc);
    var row: u16 = 1;
    while (row <= shadow.rows) : (row += 1) {
        const span = completeImageRow(shadow, row, service) orelse continue;
        if (runs.items.len > 0) {
            const last = &runs.items[runs.items.len - 1];
            if (last.image_id == span.image_id and
                last.screen_col == span.screen_col and
                last.screen_top + last.screen_row_count == row and
                last.image_row + last.screen_row_count == span.image_row and
                last.needs_draw == span.needs_draw)
            {
                last.screen_row_count += 1;
                continue;
            }
        }
        try runs.append(alloc, .{
            .image_id = span.image_id,
            .image_row = span.image_row,
            .screen_top = row,
            .screen_col = span.screen_col,
            .screen_row_count = 1,
            .needs_draw = span.needs_draw,
        });
    }
    return runs;
}

const RowSpan = struct {
    image_id: u32,
    image_row: u16,
    screen_col: u16,
    needs_draw: bool,
};

fn completeImageRow(shadow: *const vt_emulator.Grid, row: u16, service: *const Service) ?RowSpan {
    var resolver: image_placeholder.RowResolver = .{};
    var span: ?RowSpan = null;
    var expected_col: u16 = 0;
    var col: u16 = 1;
    while (col <= shadow.cols) : (col += 1) {
        const cell = shadow.cellAt(row, col) orelse return null;
        const suffix = shadow.combiningSuffix(cell.combining_suffix_id) orelse "";
        const fg: ?[3]u8 = switch (cell.style.fg) {
            .rgb => |rgb| .{ rgb.r, rgb.g, rgb.b },
            else => null,
        };
        const ref = resolver.next(cell.codepoint, suffix, fg) orelse {
            if (span != null) break;
            continue;
        };
        if (span) |*s| {
            if (ref.image_id != s.image_id or ref.row != s.image_row or ref.col != expected_col) return null;
            if (!cell.image_pixels_drawn) s.needs_draw = true;
        } else {
            if (ref.col != 0) return null;
            span = .{ .image_id = ref.image_id, .image_row = ref.row, .screen_col = col, .needs_draw = !cell.image_pixels_drawn };
        }
        expected_col += 1;
    }
    const s = span orelse return null;
    if (s.image_id > service.instances.items.len) return null;
    if (expected_col != service.instances.items[s.image_id - 1].cols) return null;
    return s;
}

fn markDrawn(shadow: *vt_emulator.Grid, run: Run, screen_rows: u16) void {
    var row = run.screen_top;
    while (row < run.screen_top + screen_rows) : (row += 1) {
        var col = run.screen_col;
        while (col <= shadow.cols) : (col += 1) {
            if (!shadow.markImagePixelsDrawn(row, col)) break;
        }
    }
}

test "layout keeps aspect ratio, honors the box, and never upscales" {
    const cell = CellSize{ .width_px = 10, .height_px = 20 };
    try std.testing.expectEqual(Placement{ .cols = 40, .rows = 10 }, layout(400, 200, .{ .max_cols = 80, .max_rows = 30 }, cell));
    try std.testing.expectEqual(Placement{ .cols = 20, .rows = 5 }, layout(400, 200, .{ .max_cols = 20, .max_rows = 30 }, cell));
    try std.testing.expectEqual(Placement{ .cols = 2, .rows = 1 }, layout(16, 16, .{ .max_cols = 80, .max_rows = 30 }, cell));
    try std.testing.expectEqual(Placement{ .cols = 0, .rows = 0 }, layout(16, 16, .{ .max_cols = 80, .max_rows = 30 }, .{ .width_px = 0, .height_px = 0 }));
}

const CaptureSink = struct {
    bytes: std.ArrayList(u8) = .empty,
    writes: usize = 0,

    fn deinit(self: *CaptureSink) void {
        self.bytes.deinit(std.testing.allocator);
    }

    fn sink(self: *CaptureSink) terminal_diff.FrameSink {
        return .{ .ctx = self, .write_frame = write };
    }

    fn write(ctx: *anyopaque, _: *types.Metrics, bytes: []const u8) terminal_diff.FrameSinkWriteResult {
        const self: *CaptureSink = @ptrCast(@alignCast(ctx));
        self.writes += 1;
        self.bytes.appendSlice(std.testing.allocator, bytes) catch |err| return .{ .partial = .{ .accepted_bytes = 0, .err = err } };
        return .complete;
    }
};

fn testPng(alloc: Allocator, width: u32, height: u32) ![]u8 {
    var image = try Raster.init(alloc, width, height);
    defer image.deinit(alloc);
    for (0..@as(usize, width) * height) |i| image.pixels[i * 4 ..][0..4].* = .{ 200, 40, 40, 255 };
    return codecs.png.encode(alloc, image);
}

test "kitty frames transmit each shown image once, before the frame" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .kitty, .cell = .{ .width_px = 10, .height_px = 20 } });
    defer service.deinit();
    const png = try testPng(alloc, 40, 40);
    defer alloc.free(png);

    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    const placement = (try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 80, .max_rows = 10 }, "  ", &rows)).?;
    try std.testing.expectEqual(Placement{ .cols = 4, .rows = 2 }, placement);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, rows.items, "\n"));

    var capture: CaptureSink = .{};
    defer capture.deinit();
    var metrics: types.Metrics = .{};
    try std.testing.expect(service.writeFrame(capture.sink(), &metrics, rows.items) == .complete);
    const first = capture.bytes.items;
    const transmit_at = std.mem.indexOf(u8, first, "\x1b_Ga=T,U=1,f=100").?;
    const frame_at = std.mem.indexOf(u8, first, "  \x1b[38;2;0;0;1m").?;
    try std.testing.expect(transmit_at < frame_at);
    try std.testing.expect(std.mem.indexOf(u8, first, ",c=4,r=2,") != null);

    capture.bytes.clearRetainingCapacity();
    try std.testing.expect(service.writeFrame(capture.sink(), &metrics, rows.items) == .complete);
    try std.testing.expect(std.mem.indexOf(u8, capture.bytes.items, "\x1b_G") == null);

    // A terminal reset discards kitty images, so they follow the frame again.
    capture.bytes.clearRetainingCapacity();
    var reset_frame: std.ArrayList(u8) = .empty;
    defer reset_frame.deinit(alloc);
    try reset_frame.appendSlice(alloc, "\x1bc");
    try reset_frame.appendSlice(alloc, rows.items);
    try std.testing.expect(service.writeFrame(capture.sink(), &metrics, reset_frame.items) == .complete);
    const reset_out = capture.bytes.items;
    try std.testing.expect(std.mem.indexOf(u8, reset_out, "\x1bc").? < std.mem.indexOf(u8, reset_out, "\x1b_Ga=T").?);
}

test "sixel preserves faint antialiased strokes and recomposites after background changes" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .sixel, .cell = .{ .width_px = 1, .height_px = 6 }, .background = .{ 20, 40, 60 } });
    defer service.deinit();
    install(&service);
    defer uninstall();
    var image = try Raster.init(alloc, 3, 1);
    defer image.deinit(alloc);
    image.pixel(1, 0).* = .{ 255, 255, 255, 64 };
    const png = try codecs.png.encode(alloc, image);
    defer alloc.free(png);
    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    _ = try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 3, .max_rows = 1 }, "", &rows);
    const instance = &service.instances.items[0];
    const before = try alloc.dupe(u8, try service.overlayPayload(instance, 0, 1));
    defer alloc.free(before);
    // The center column's faint stroke used to be discarded entirely.
    try std.testing.expect(std.mem.indexOf(u8, before, "#0?@\x1b\\") != null);
    try std.testing.expectEqual(@as(u8, 64), service.entries.items[0].ready.image.pixel(1, 0)[3]);
    try std.testing.expectEqual(@as(u8, 64), instance.box.?.pixel(1, 0)[3]);
    const cached = service.cached_bytes;
    setBackground(.{ 255, 255, 255 });
    try std.testing.expect(instance.overlay == null);
    try std.testing.expectEqual(cached - before.len, service.cached_bytes);
    const after = try service.overlayPayload(instance, 0, 1);
    try std.testing.expect(std.mem.indexOf(u8, after, "#0?@\x1b\\") != null);
    try std.testing.expect(std.mem.indexOf(u8, after, ";2;100;100;100") != null);
    try std.testing.expect(!std.mem.eql(u8, before, after));
}

test "sixel overlays draw once per exposure and redraw after cells are rewritten" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .sixel, .cell = .{ .width_px = 4, .height_px = 6 } });
    defer service.deinit();
    const png = try testPng(alloc, 8, 12);
    defer alloc.free(png);

    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    _ = (try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 20, .max_rows = 10 }, "", &rows)).?;

    var shadow = try vt_emulator.Grid.init(alloc, 10, 5);
    defer shadow.deinit();
    try shadow.feed("\x1b[2;3H");
    var lines = std.mem.splitScalar(u8, rows.items, '\n');
    var line_row: u16 = 2;
    while (lines.next()) |line| : (line_row += 1) {
        var buf: [16]u8 = undefined;
        try shadow.feed(try std.fmt.bufPrint(&buf, "\x1b[{d};3H", .{line_row}));
        try shadow.feed(line);
    }

    // The wire never carries placeholder cells for out-of-band protocols.
    var capture: CaptureSink = .{};
    defer capture.deinit();
    var metrics: types.Metrics = .{};
    try std.testing.expect(service.writeFrame(capture.sink(), &metrics, rows.items) == .complete);
    try std.testing.expect(std.mem.indexOf(u8, capture.bytes.items, image_placeholder.utf8) == null);

    capture.bytes.clearRetainingCapacity();
    service.afterCommit(&shadow, capture.sink(), &metrics);
    const drawn = capture.bytes.items;
    try std.testing.expect(std.mem.startsWith(u8, drawn, "\x1b[?2026h\x1b7\x1b[2;3H\x1bP0;1;0q\"1;1;8;12"));
    try std.testing.expect(std.mem.endsWith(u8, drawn, "\x1b\\\x1b8\x1b[?2026l"));
    try std.testing.expect(shadow.cellAt(2, 3).?.image_pixels_drawn);
    try std.testing.expect(shadow.cellAt(3, 4).?.image_pixels_drawn);

    capture.bytes.clearRetainingCapacity();
    service.afterCommit(&shadow, capture.sink(), &metrics);
    try std.testing.expectEqual(@as(usize, 0), capture.bytes.items.len);

    // Rewriting the second image row (as a repaint would) destroys its
    // pixels; only that row is drawn again.
    var second_row = std.mem.splitScalar(u8, rows.items, '\n');
    _ = second_row.next();
    try shadow.feed("\x1b[3;3H");
    try shadow.feed(second_row.next().?);
    service.afterCommit(&shadow, capture.sink(), &metrics);
    try std.testing.expect(std.mem.indexOf(u8, capture.bytes.items, "\x1b[3;3H\x1bP0;1;0q\"1;1;8;6") != null);
}

test "rows partly covered by other text are never painted" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .iterm2, .cell = .{ .width_px = 4, .height_px = 6 } });
    defer service.deinit();
    const png = try testPng(alloc, 8, 6);
    defer alloc.free(png);
    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    _ = (try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 20, .max_rows = 10 }, "", &rows)).?;

    var shadow = try vt_emulator.Grid.init(alloc, 10, 4);
    defer shadow.deinit();
    try shadow.feed("\x1b[1;1H");
    try shadow.feed(rows.items);
    try shadow.feed("\x1b[1;2Hx");
    var capture: CaptureSink = .{};
    defer capture.deinit();
    var metrics: types.Metrics = .{};
    service.afterCommit(&shadow, capture.sink(), &metrics);
    try std.testing.expectEqual(@as(usize, 0), capture.bytes.items.len);
}

test "half-block fallback renders text rows and undecodable sources render nothing" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .blocks, .cell = .{ .width_px = 10, .height_px = 20 } });
    defer service.deinit();
    const png = try testPng(alloc, 20, 40);
    defer alloc.free(png);
    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    const placement = (try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 80, .max_rows = 10 }, "> ", &rows)).?;
    try std.testing.expectEqual(Placement{ .cols = 2, .rows = 2 }, placement);
    try std.testing.expect(std.mem.startsWith(u8, rows.items, "> \x1b[38;2;200;40;40m\x1b[48;2;200;40;40m\u{2580}"));
    try std.testing.expect(std.mem.indexOf(u8, rows.items, "\n> ") != null);

    rows.clearRetainingCapacity();
    try std.testing.expectEqual(@as(?Placement, null), try service.renderRows(alloc, .{ .encoded = "not an image" }, .{ .max_cols = 80, .max_rows = 10 }, "", &rows));
    try std.testing.expectEqual(@as(usize, 0), rows.items.len);
    try std.testing.expect(!service.canRender(.{ .encoded = "not an image" }));
    try std.testing.expect(service.canRender(.{ .encoded = png }));
}

test "placeholder frames hold back their sync end until overlays are drawn" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .sixel, .cell = .{ .width_px = 4, .height_px = 6 } });
    defer service.deinit();
    const png = try testPng(alloc, 8, 6);
    defer alloc.free(png);
    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    _ = (try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 20, .max_rows = 10 }, "", &rows)).?;

    var frame: std.ArrayList(u8) = .empty;
    defer frame.deinit(alloc);
    try frame.appendSlice(alloc, "\x1b[?2026h\x1b[1;1H");
    try frame.appendSlice(alloc, rows.items);
    try frame.appendSlice(alloc, "\x1b[?2026l\x1b[?25h");

    var shadow = try vt_emulator.Grid.init(alloc, 10, 4);
    defer shadow.deinit();
    try shadow.feed(frame.items);

    var capture: CaptureSink = .{};
    defer capture.deinit();
    var metrics: types.Metrics = .{};
    try std.testing.expect(service.writeFrame(capture.sink(), &metrics, frame.items) == .complete);
    try std.testing.expect(!std.mem.endsWith(u8, capture.bytes.items, "\x1b[?2026l\x1b[?25h"));
    service.afterCommit(&shadow, capture.sink(), &metrics);
    const out = capture.bytes.items;
    const pixels_at = std.mem.indexOf(u8, out, "\x1bP0;1;0q").?;
    // Exactly one synchronized update: the overlay sits before its end.
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, out, "\x1b[?2026h"));
    try std.testing.expect(pixels_at < std.mem.lastIndexOf(u8, out, "\x1b[?2026l").?);
    try std.testing.expect(std.mem.endsWith(u8, out, "\x1b[?2026l\x1b[?25h"));
}

test "instance caches stay within their budget, evicting the least recently used" {
    const alloc = std.testing.allocator;
    var service = Service.init(alloc, .{ .protocol = .blocks, .cell = .{ .width_px = 10, .height_px = 20 } });
    defer service.deinit();
    service.cache_budget = 2048;
    const png = try testPng(alloc, 200, 200);
    defer alloc.free(png);
    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    // Each width is a distinct instance with its own half-block text.
    var cols: u16 = 4;
    while (cols < 20) : (cols += 1) {
        rows.clearRetainingCapacity();
        _ = (try service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = cols, .max_rows = 30 }, "", &rows)).?;
        // Only the instance just drawn may hold more than the budget alone.
        const newest = cacheBytes(service.instances.items[service.instances.items.len - 1]);
        try std.testing.expect(service.cached_bytes <= @max(service.cache_budget, newest));
    }
    var retained: usize = 0;
    for (service.instances.items) |instance| retained += cacheBytes(instance);
    try std.testing.expectEqual(service.cached_bytes, retained);
    // The newest instance keeps its cache; the oldest lost theirs.
    try std.testing.expect(service.instances.items[service.instances.items.len - 1].block_rows != null);
    try std.testing.expect(service.instances.items[0].block_rows == null);
}

fn checkImageCacheAllocationFailures(alloc: Allocator) !void {
    var service = Service.init(alloc, .{ .protocol = .blocks, .cell = .{ .width_px = 10, .height_px = 20 } });
    defer service.deinit();
    const png = try testPng(std.testing.allocator, 20, 20);
    defer std.testing.allocator.free(png);
    var rows: std.ArrayList(u8) = .empty;
    defer rows.deinit(alloc);
    _ = service.renderRows(alloc, .{ .encoded = png }, .{ .max_cols = 20, .max_rows = 10 }, "", &rows) catch |err| switch (err) {
        // Allocating writers report allocation failure as WriteFailed.
        error.WriteFailed => return error.OutOfMemory,
        else => return err,
    };
}

test "image cache registration and rendering release allocation failures" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, checkImageCacheAllocationFailures, .{});
}

test "failed frame tails retain their unwritten bytes before the next frame" {
    const PartialSink = struct {
        capture: CaptureSink = .{},
        fail: bool = true,
        fn write(ctx: *anyopaque, metrics: *types.Metrics, bytes: []const u8) terminal_diff.FrameSinkWriteResult {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (!self.fail) return CaptureSink.write(&self.capture, metrics, bytes);
            _ = CaptureSink.write(&self.capture, metrics, bytes[0..2]);
            return .{ .partial = .{ .accepted_bytes = 2, .err = error.TestWriteFailure } };
        }
    };
    var service = Service.init(std.testing.allocator, .{ .protocol = .sixel });
    defer service.deinit();
    const tail = "\x1b[?2026l\x1b[?25h";
    @memcpy(service.deferred_tail[0..tail.len], tail);
    service.deferred_tail_len = tail.len;
    var partial = PartialSink{};
    defer partial.capture.deinit();
    const sink = terminal_diff.FrameSink{ .ctx = &partial, .write_frame = PartialSink.write };
    var metrics: types.Metrics = .{};
    const result = service.writeFrame(sink, &metrics, "next frame");
    try std.testing.expect(result == .partial);
    try std.testing.expectEqual(@as(usize, 0), result.partial.accepted_bytes);
    try std.testing.expectEqual(tail.len - 2, service.deferred_tail_len);
    partial.fail = false;
    try std.testing.expect(service.writeFrame(sink, &metrics, "next frame") == .complete);
    try std.testing.expectEqualStrings(tail ++ "next frame", partial.capture.bytes.items);
    try std.testing.expectEqual(@as(usize, 0), service.deferred_tail_len);
}
