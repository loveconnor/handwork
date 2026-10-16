//! SIXEL encoding (DEC VT3xx graphics), used by Windows Terminal, xterm,
//! foot, WezTerm, mlterm, Konsole, and others.
//!
//! Colors are reduced with median cut over a 15-bit histogram to at most
//! 255 palette entries. Pixels whose alpha is below half are left unset;
//! with background mode 1 the terminal keeps whatever was behind them.

const std = @import("std");
const raster_mod = @import("../../../core/images/raster.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;

const max_colors: usize = 255;
const bin_count: usize = 1 << 15;
const alpha_threshold: u8 = 128;

pub fn encode(alloc: Allocator, image: Raster, writer: *std.Io.Writer) !void {
    var palette: Palette = .{};
    const bins = try alloc.alloc(u32, bin_count);
    defer alloc.free(bins);
    try buildPalette(alloc, image, bins, &palette);

    // bins is reused as a bin -> palette index map (0xffff_ffff = unused).
    for (bins, 0..) |*slot, bin| {
        slot.* = if (slot.* == 0) std.math.maxInt(u32) else palette.nearest(binColor(@intCast(bin)));
    }

    // DCS P1=0 (aspect 2:1 default, overridden by raster attributes),
    // P2=1 (unset pixels stay transparent), P3=0.
    try writer.writeAll("\x1bP0;1;0q");
    try writer.print("\"1;1;{d};{d}", .{ image.width, image.height });
    for (palette.colors[0..palette.len], 0..) |color, i| {
        try writer.print("#{d};2;{d};{d};{d}", .{ i, percent(color[0]), percent(color[1]), percent(color[2]) });
    }

    // One mask row per palette entry, filled in a single pass per band.
    const masks = try alloc.alloc(u8, palette.len * @as(usize, image.width));
    defer alloc.free(masks);
    @memset(masks, 0);
    var used: [max_colors]bool = undefined;
    const width: usize = image.width;

    var band_top: u32 = 0;
    while (band_top < image.height) : (band_top += 6) {
        const band_bottom = @min(band_top + 6, image.height);
        @memset(&used, false);
        var y = band_top;
        while (y < band_bottom) : (y += 1) {
            const bit = @as(u8, 1) << @intCast(y - band_top);
            var x: u32 = 0;
            while (x < image.width) : (x += 1) {
                const index = paletteIndexAt(image, bins, x, y) orelse continue;
                used[index] = true;
                masks[index * width + x] |= bit;
            }
        }

        var first_color = true;
        for (used[0..palette.len], 0..) |is_used, color_index| {
            if (!is_used) continue;
            const row_masks = masks[color_index * width ..][0..width];
            if (!first_color) try writer.writeByte('$');
            first_color = false;
            try writer.print("#{d}", .{color_index});
            try writeRuns(writer, row_masks);
            @memset(row_masks, 0);
        }
        if (band_bottom < image.height) try writer.writeByte('-');
    }
    try writer.writeAll("\x1b\\");
}

fn paletteIndexAt(image: Raster, bins: []const u32, x: u32, y: u32) ?usize {
    const p = image.pixel(x, y);
    if (p[3] < alpha_threshold) return null;
    const index = bins[binOf(p.*)];
    return if (index == std.math.maxInt(u32)) null else index;
}

fn writeRuns(writer: *std.Io.Writer, masks: []const u8) !void {
    // Trailing empty sixels are implied by the next carriage return.
    var end = masks.len;
    while (end > 0 and masks[end - 1] == 0) end -= 1;
    var i: usize = 0;
    while (i < end) {
        const value = masks[i];
        var run: usize = 1;
        while (i + run < end and masks[i + run] == value) run += 1;
        const char: u8 = '?' + value;
        if (run > 3) {
            try writer.print("!{d}{c}", .{ run, char });
        } else {
            for (0..run) |_| try writer.writeByte(char);
        }
        i += run;
    }
}

fn percent(channel: u8) u32 {
    return (@as(u32, channel) * 100 + 127) / 255;
}

fn binOf(p: [4]u8) u15 {
    return @intCast((@as(u32, p[0] >> 3) << 10) | (@as(u32, p[1] >> 3) << 5) | (p[2] >> 3));
}

fn binColor(bin: u15) [3]u8 {
    const r: u8 = @intCast((bin >> 10) & 31);
    const g: u8 = @intCast((bin >> 5) & 31);
    const b: u8 = @intCast(bin & 31);
    return .{ r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2 };
}

const Palette = struct {
    colors: [max_colors][3]u8 = undefined,
    len: usize = 0,

    fn nearest(self: *const Palette, color: [3]u8) u32 {
        var best: u32 = 0;
        var best_distance: u32 = std.math.maxInt(u32);
        for (self.colors[0..self.len], 0..) |candidate, i| {
            var distance: u32 = 0;
            inline for (0..3) |c| {
                const d = @as(i32, candidate[c]) - color[c];
                distance += @intCast(d * d);
            }
            if (distance < best_distance) {
                best_distance = distance;
                best = @intCast(i);
            }
        }
        return best;
    }
};

const ColorBox = struct {
    /// Indexes into the shared list of occupied bins.
    start: usize,
    end: usize,
};

fn buildPalette(alloc: Allocator, image: Raster, bins: []u32, palette: *Palette) !void {
    @memset(bins, 0);
    var i: usize = 0;
    while (i < image.pixels.len) : (i += 4) {
        const p = image.pixels[i..][0..4].*;
        if (p[3] < alpha_threshold) continue;
        bins[binOf(p)] += 1;
    }

    const occupied = try alloc.alloc(u15, bin_count);
    defer alloc.free(occupied);
    var occupied_len: usize = 0;
    for (bins, 0..) |count, bin| {
        if (count == 0) continue;
        occupied[occupied_len] = @intCast(bin);
        occupied_len += 1;
    }
    if (occupied_len == 0) return;

    var boxes: [max_colors]ColorBox = undefined;
    boxes[0] = .{ .start = 0, .end = occupied_len };
    var box_count: usize = 1;
    while (box_count < max_colors) {
        // Split the box with the most pixels that still has more than one color.
        var target: ?usize = null;
        var target_weight: u64 = 0;
        for (boxes[0..box_count], 0..) |box, b| {
            if (box.end - box.start < 2) continue;
            var weight: u64 = 0;
            for (occupied[box.start..box.end]) |bin| weight += bins[bin];
            if (weight > target_weight) {
                target_weight = weight;
                target = b;
            }
        }
        const b = target orelse break;
        const box = boxes[b];
        const channel = widestChannel(occupied[box.start..box.end]);
        std.mem.sort(u15, occupied[box.start..box.end], channel, lessOnChannel);
        var half: u64 = 0;
        var split = box.start;
        while (split < box.end - 1) : (split += 1) {
            half += bins[occupied[split]];
            if (half * 2 >= target_weight) break;
        }
        // A dominant last bin would leave the upper half empty; keep at
        // least one bin on each side.
        split = @min(split, box.end - 2);
        boxes[b] = .{ .start = box.start, .end = split + 1 };
        boxes[box_count] = .{ .start = split + 1, .end = box.end };
        box_count += 1;
    }

    for (boxes[0..box_count]) |box| {
        var sums = [3]u64{ 0, 0, 0 };
        var weight: u64 = 0;
        for (occupied[box.start..box.end]) |bin| {
            const color = binColor(bin);
            const count = bins[bin];
            inline for (0..3) |c| sums[c] += @as(u64, color[c]) * count;
            weight += count;
        }
        palette.colors[palette.len] = .{
            @intCast(sums[0] / weight),
            @intCast(sums[1] / weight),
            @intCast(sums[2] / weight),
        };
        palette.len += 1;
    }
}

fn widestChannel(bins: []const u15) u2 {
    var lo = [3]u8{ 255, 255, 255 };
    var hi = [3]u8{ 0, 0, 0 };
    for (bins) |bin| {
        const color = binColor(bin);
        inline for (0..3) |c| {
            lo[c] = @min(lo[c], color[c]);
            hi[c] = @max(hi[c], color[c]);
        }
    }
    var best: u2 = 0;
    var best_range: u8 = 0;
    inline for (0..3) |c| {
        if (hi[c] - lo[c] > best_range) {
            best_range = hi[c] - lo[c];
            best = c;
        }
    }
    return best;
}

fn lessOnChannel(channel: u2, a: u15, b: u15) bool {
    return binColor(a)[channel] < binColor(b)[channel];
}

test "encodes a two-color image with raster attributes and palette" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 4, 7);
    defer image.deinit(alloc);
    var y: u32 = 0;
    while (y < 7) : (y += 1) {
        var x: u32 = 0;
        while (x < 4) : (x += 1) {
            image.pixel(x, y).* = if (x < 2) .{ 255, 0, 0, 255 } else .{ 0, 0, 255, 255 };
        }
    }
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try encode(alloc, image, &out.writer);
    const bytes = out.written();
    try std.testing.expect(std.mem.startsWith(u8, bytes, "\x1bP0;1;0q\"1;1;4;7"));
    try std.testing.expect(std.mem.endsWith(u8, bytes, "\x1b\\"));
    try std.testing.expect(std.mem.indexOf(u8, bytes, ";2;100;0;0") != null);
    try std.testing.expect(std.mem.indexOf(u8, bytes, ";2;0;0;100") != null);
    // Two bands: rows 0-5 then row 6, separated by exactly one LF.
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, bytes, "-"));
    // Full sixel columns: '?' + 63 = '~'.
    try std.testing.expect(std.mem.indexOf(u8, bytes, "~~") != null);
}

test "transparent pixels are never painted" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 3, 1);
    defer image.deinit(alloc);
    image.pixel(1, 0).* = .{ 9, 9, 9, 255 };
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try encode(alloc, image, &out.writer);
    const bytes = out.written();
    // One color, painted only in the middle column: '?' (empty), '@' (bit 0).
    try std.testing.expect(std.mem.indexOf(u8, bytes, "#0?@\x1b\\") != null);
}

test "run-length encoding collapses long runs" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeRuns(&out.writer, &.{ 63, 63, 63, 63, 63, 1, 0, 0 });
    try std.testing.expectEqualStrings("!5~@", out.written());
}

test "median cut caps the palette at 255 colors" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 64, 64);
    defer image.deinit(alloc);
    var y: u32 = 0;
    while (y < 64) : (y += 1) {
        var x: u32 = 0;
        while (x < 64) : (x += 1) image.pixel(x, y).* = .{ @intCast(x * 4), @intCast(y * 4), @intCast((x + y) * 2), 255 };
    }
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try encode(alloc, image, &out.writer);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "#254;2;") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "#255;2;") == null);
}

test "a dominant color never leaves an empty palette box" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 10, 10);
    defer image.deinit(alloc);
    for (0..100) |i| image.pixels[i * 4 ..][0..4].* = .{ 250, 250, 250, 255 };
    image.pixel(0, 0).* = .{ 0, 0, 0, 255 };
    image.pixel(1, 0).* = .{ 10, 0, 0, 255 };
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try encode(alloc, image, &out.writer);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "#2;2;") != null);
}
