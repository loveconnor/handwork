const std = @import("std");
const debug_trace = @import("../../core/shared/debug_trace.zig");
const io_mod = @import("../../core/shared/io.zig");
const pathing = @import("../../core/workspace/pathing.zig");
const permission_gate = @import("../../core/permissions/permission_gate.zig");
const read_tracker = @import("../../core/workspace/read_tracker.zig");
const text_utils = @import("../../core/shared/text_utils.zig");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const tool_result_errors = @import("../../core/tooling/tool_result_errors.zig");
const write_file_impl = @import("write_file.zig");

const Allocator = std.mem.Allocator;

// Allow freshness snapshots for files larger than read_file can show the model.
const max_snapshot_file_bytes: usize = 10 * 1024 * 1024;
// Keep one tool result under common model input limits without a tokenizer.
const max_model_output_bytes: usize = 256 * 1024;
// Bound tiny-line files so one read cannot dominate a turn.
const max_line_count: usize = 2000;
const line_truncated_suffix = "... (line truncated)";

const whitespace = " \t\r\n";

/// Typed input for the built-in read_file tool.
pub const Input = struct {
    path: []u8 = &.{},
    files: []Input = &.{},
    output_budget: usize = max_model_output_bytes,
    start_line: usize = 1,
    line_count: usize = tool_dispatch.default_max_read_file_lines,

    /// Frees the owned normalized path.
    pub fn deinit(self: *Input, alloc: Allocator) void {
        for (self.files) |*file| file.deinit(alloc);
        alloc.free(self.files);
        alloc.free(self.path);
        self.* = .{ .path = &.{} };
    }
};

/// Decodes read_file JSON into an owned Input released by ToolInput.deinit.
pub fn decode(ctx: tool_dispatch.DispatchContext, args_json: []const u8) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    var parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, args_json, .{}) catch {
        return .{ .failure = try ctx.allocator.dupe(u8, "read_file arguments must be valid JSON") };
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return .{ .failure = try ctx.allocator.dupe(u8, "read_file arguments must be an object") };
    }

    if (parsed.value.object.get("files")) |files| {
        if (parsed.value.object.contains("path") or parsed.value.object.contains("start_line") or parsed.value.object.contains("line_count") or
            files != .array or files.array.items.len == 0 or files.array.items.len > 32)
            return .{ .failure = try ctx.allocator.dupe(u8, "read_file accepts path/range OR files (1 to 32 path/range objects)") };
        const input = try ctx.allocator.create(Input);
        input.* = .{};
        var owned = true;
        defer if (owned) {
            input.deinit(ctx.allocator);
            ctx.allocator.destroy(input);
        };
        // The defer above owns the allocation on both semantic and allocation failures.
        input.files = try ctx.allocator.alloc(Input, files.array.items.len);
        for (input.files) |*file| file.* = .{};
        for (files.array.items, input.files) |value, *file| {
            if (value != .object or value.object.contains("files"))
                return .{ .failure = try ctx.allocator.dupe(u8, "read_file files must contain flat path/range objects") };
            const json = try std.json.Stringify.valueAlloc(ctx.allocator, value, .{});
            defer ctx.allocator.free(json);
            switch (try decode(ctx, json)) {
                .failure => |reason| return .{ .failure = reason },
                .input => |child| {
                    file.* = child.as(Input).*;
                    ctx.allocator.destroy(child.as(Input));
                },
            }
        }
        owned = false;
        return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
    }

    const path_value = parsed.value.object.get("path") orelse {
        return .{ .failure = try ctx.allocator.dupe(u8, "read_file requires string field \"path\"") };
    };
    if (path_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(u8, "read_file field \"path\" must be a string") };
    }

    const input = try ctx.allocator.create(Input);
    var input_initialized = false;
    var input_transferred = false;
    defer if (!input_transferred) {
        if (input_initialized) input.deinit(ctx.allocator);
        ctx.allocator.destroy(input);
    };
    input.* = .{
        .path = try ctx.allocator.dupe(u8, path_value.string),
    };
    input_initialized = true;

    switch (try parseOptionalPositive(ctx.allocator, parsed.value.object, "start_line")) {
        .missing => {},
        .value => |value| input.start_line = value,
        .failure => |body| return .{ .failure = body },
    }
    switch (try parseOptionalPositive(ctx.allocator, parsed.value.object, "line_count")) {
        .missing => {},
        .value => |value| input.line_count = @min(value, max_line_count),
        .failure => |body| return .{ .failure = body },
    }

    input_transferred = true;
    return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
}

const PositiveParse = union(enum) {
    missing,
    value: usize,
    failure: []u8,
};

fn parseOptionalPositive(alloc: Allocator, object: std.json.ObjectMap, key: []const u8) tool_dispatch.DispatchError!PositiveParse {
    const value = object.get(key) orelse return .missing;
    if (value != .integer or value.integer < 1) {
        return .{ .failure = try std.fmt.allocPrint(alloc, "read_file field \"{s}\" must be a positive integer", .{key}) };
    }
    return .{ .value = @intCast(value.integer) };
}

fn inputDeinit(ptr: *anyopaque, alloc: Allocator) void {
    const input: *Input = @ptrCast(@alignCast(ptr));
    input.deinit(alloc);
    alloc.destroy(input);
}

/// Normalizes and validates the owned Input before permission checks.
pub fn validate(ctx: tool_dispatch.DispatchContext, erased: tool_dispatch.ToolInput) tool_dispatch.DispatchError!?[]u8 {
    const input = erased.as(Input);
    if (input.files.len > 0) {
        for (input.files) |*file| {
            if (try validate(ctx, .{ .ptr = file, .deinit_fn = inputDeinit })) |reason| return reason;
        }
        return null;
    }
    const trimmed = std.mem.trim(u8, input.path, whitespace);
    try replacePath(ctx.allocator, input, trimmed);

    if (input.path.len == 0) {
        return try ctx.allocator.dupe(u8, "read_file field \"path\" must not be empty");
    }
    return null;
}

fn replacePath(alloc: Allocator, input: *Input, next: []const u8) tool_dispatch.DispatchError!void {
    if (std.mem.eql(u8, input.path, next)) return;
    const owned = try alloc.dupe(u8, next);
    replaceOwnedPath(alloc, input, owned);
}

fn replaceOwnedPath(alloc: Allocator, input: *Input, owned: []u8) void {
    alloc.free(input.path);
    input.path = owned;
}

/// Reads the validated file and returns an owned tool result body.
pub fn call(ctx: tool_dispatch.DispatchContext, erased: tool_dispatch.ToolInput) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    const input = erased.as(Input);
    if (input.files.len > 0) return callBatch(ctx, input.files);
    return callOne(ctx, input);
}

fn callOne(ctx: tool_dispatch.DispatchContext, input: *const Input) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    var arena_state = std.heap.ArenaAllocator.init(ctx.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const target = pathing.resolveWorkspaceOrExternalPath(arena, ctx.workspace_root, input.path) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return readFileFailure(ctx.allocator, err, input.path);
    };

    const zio = io_mod.getIo();
    var file = io_mod.openExistingReadOnlyRegularFile(std.Io.Dir.cwd(), target, .no_follow) catch |err| {
        return readFileFailure(
            ctx.allocator,
            if (err == error.DurablePathUnsafe) error.NotRegularFile else err,
            target,
        );
    };
    defer file.close(zio);

    const stat = file.stat(zio) catch |err| {
        return readFileFailure(ctx.allocator, err, target);
    };
    const truncated_by_size = stat.size > max_snapshot_file_bytes;
    const read_len: usize = @intCast(@min(stat.size, max_snapshot_file_bytes));
    const content = try arena.alloc(u8, read_len);
    var read_buf: [8192]u8 = undefined;
    var reader = file.reader(zio, &read_buf);
    const actual_len = readIntoBuffer(&reader.interface, content) catch |err| {
        return readFileFailure(ctx.allocator, err, target);
    };
    const text = content[0..actual_len];
    const rel = pathing.workspaceRelativePath(arena, ctx.workspace_root, target) catch target;

    if (!text_utils.isModelSafeText(text)) {
        tool_dispatch.reportToolResultMemory(ctx, .{
            .model_view_covers_full_file = false,
        });
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "<path>{s}</path>\n<content>binary or non-utf8 file omitted ({d} bytes)</content>",
            .{ rel, stat.size },
        ) };
    }

    var selected = input.*;
    selected.line_count = @min(selected.line_count, ctx.max_read_file_lines);

    var records: std.ArrayList(LineRecord) = .empty;
    defer freeLineRecords(arena, &records);
    const scan = try selectLinesFromContent(arena, text, &selected, ctx.max_read_file_line_len, &records);
    const snapshot_covers_full_file = !truncated_by_size and actual_len == stat.size;
    const model_view_covers_full_file = snapshot_covers_full_file and modelViewCoversFullFile(&selected, scan, records.items.len);
    try recordSuccessfulRead(ctx, target, stat, scan.content_hash, model_view_covers_full_file, snapshot_covers_full_file);
    tool_dispatch.reportToolResultMemory(ctx, .{
        .model_view_covers_full_file = model_view_covers_full_file,
    });

    return .{ .success = try formatReadOutput(ctx.allocator, rel, &selected, records.items, scan, snapshot_covers_full_file) };
}

// Each child read owns a short-lived snapshot. Only disclosed results enter the
// session tracker; a batch cap must never turn an undisclosed file into evidence.
fn callBatch(ctx: tool_dispatch.DispatchContext, files: []Input) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    var scratch_state = std.heap.ArenaAllocator.init(ctx.allocator);
    defer scratch_state.deinit();
    const cap = @min(ctx.max_tool_result_bytes, ctx.max_read_file_bytes);
    var failed = false;
    var operations: usize = 0;
    var disclosed: u32 = 0;
    var full_files: u32 = 0;
    defer debug_trace.logf("agent", "event=read_batch_complete file_read_operations={d}", .{operations});
    for (files, 0..) |file, index| {
        if (ctx.cancel_flag) |flag| if (flag.load(.acquire)) return error.Cancelled;
        const remaining = cap -| out.written().len;
        if (remaining < 512 + file.path.len) {
            out.writer.print("[read_file] batch budget reached; {d} files not read. Request remaining paths with ranges.\n", .{files.len - index}) catch return error.OutOfMemory;
            break;
        }
        // Deduplicate identical requests without suppressing different ranges.
        var duplicate = false;
        for (files[0..index]) |previous| {
            if (std.mem.eql(u8, previous.path, file.path) and previous.start_line == file.start_line and previous.line_count == file.line_count) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) continue;
        // Reuse backing storage even when the caller uses a turn arena.
        _ = scratch_state.reset(.retain_capacity);
        const scratch = scratch_state.allocator();
        var tracker = read_tracker.ReadTracker.init(scratch);
        defer tracker.deinit();
        var child_ctx = ctx;
        child_ctx.allocator = scratch;
        child_ctx.read_tracker = &tracker;
        child_ctx.tool_result_memory_sink = null;
        var selected = file;
        selected.output_budget = remaining - 512 - file.path.len;
        operations += 1;
        const result = try callOne(child_ctx, &selected);
        defer result.deinit(scratch);
        const body = switch (result) {
            .success => |body| body,
            .failure => |body| blk: {
                failed = true;
                break :blk body;
            },
            .rich => unreachable,
        };
        if (body.len + 128 > remaining) {
            out.writer.print("[read_file] batch budget reached; {d} files not disclosed. Request remaining paths with ranges.\n", .{files.len - index}) catch return error.OutOfMemory;
            break;
        }
        out.writer.writeAll(body) catch return error.OutOfMemory;
        out.writer.writeByte('\n') catch return error.OutOfMemory;
        if (result == .success) {
            const bit = @as(u32, 1) << @as(u5, @intCast(index));
            disclosed |= bit;
            var records = tracker.entries.valueIterator();
            while (records.next()) |record| if (record.model_view_covers_full_file) {
                full_files |= bit;
            };
        }
        if (ctx.read_tracker) |dest| {
            var entries = tracker.entries.iterator();
            while (entries.next()) |entry| try dest.record(entry.key_ptr.*, entry.value_ptr.*);
        }
    }
    // A batch cannot represent whole-file coverage with a single boolean.
    tool_dispatch.reportToolResultMemory(ctx, .{ .model_view_covers_full_file = false, .read_batch_disclosed_mask = disclosed, .read_batch_full_file_mask = full_files });
    const body = try out.toOwnedSlice();
    return if (failed) .{ .failure = body } else .{ .success = body };
}

fn readFileFailure(alloc: Allocator, err: anyerror, path: []const u8) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    if (tool_result_errors.isFilesystemAccessDenied(err)) {
        return .{ .failure = try tool_result_errors.filesystemAccessDeniedJson(alloc, "read_file", path, err) };
    }
    if (err == error.NotRegularFile) {
        const details = [_]tool_result_errors.Detail{
            .{ .name = "field", .value = .{ .string = "path" } },
            .{ .name = "path", .value = .{ .string = path } },
            .{ .name = "error", .value = .{ .string = @errorName(err) } },
        };
        return .{ .failure = try tool_result_errors.toolExecutionFailureJson(alloc, .{
            .tool_name = "read_file",
            .message = "read_file requires a regular file",
            .details = &details,
            .suggestion = "Use glob_files to inspect directory contents, then choose a regular file.",
        }) };
    }
    const details = [_]tool_result_errors.Detail{
        .{ .name = "field", .value = .{ .string = "path" } },
        .{ .name = "path", .value = .{ .string = path } },
        .{ .name = "error", .value = .{ .string = @errorName(err) } },
    };
    return .{ .failure = try tool_result_errors.toolExecutionFailureJson(alloc, .{
        .tool_name = "read_file",
        .message = "read_file failed",
        .details = &details,
        .suggestion = "Run glob_files to discover matching paths, or check the path relative to the workspace.",
    }) };
}

fn readIntoBuffer(reader: *std.Io.Reader, buffer: []u8) !usize {
    var total: usize = 0;
    while (total < buffer.len) {
        const n = try reader.readSliceShort(buffer[total..]);
        if (n == 0) break;
        total += n;
    }
    return total;
}

const LineRecord = struct {
    number: usize,
    text: []u8,
};

const ReadScan = struct {
    total_lines: usize,
    content_hash: read_tracker.ContentHash,
    display_truncated: bool,
};

const DisplayBudget = struct {
    width: usize = 1,
    bytes: usize = 0,
};

const LineSelectionState = struct {
    alloc: Allocator,
    input: *const Input,
    max_line_len: usize,
    records: *std.ArrayList(LineRecord),
    display_truncated: bool = false,
    stop_display: bool = false,
    budget: DisplayBudget = .{},

    fn keepLine(self: *LineSelectionState, line_number: usize, text: []const u8) !void {
        if (self.stop_display) return;
        if (line_number < self.input.start_line) return;
        if (self.records.items.len >= self.input.line_count) {
            self.display_truncated = true;
            self.stop_display = true;
            return;
        }
        const width = digitCount(line_number);
        if (width > self.budget.width) {
            self.budget.bytes += self.records.items.len * (width - self.budget.width);
            self.budget.width = width;
        }
        const clipped_len = @min(text.len, self.max_line_len);
        const line_truncated = text.len > self.max_line_len;
        const display_len = clipped_len + if (line_truncated) line_truncated_suffix.len else 0;
        const rendered_bytes = self.budget.bytes + renderedLineBytes(self.budget.width, display_len);
        if (rendered_bytes > self.input.output_budget) {
            self.display_truncated = true;
            self.stop_display = true;
            return;
        }
        const display_text = try self.alloc.alloc(u8, display_len);
        errdefer self.alloc.free(display_text);
        @memcpy(display_text[0..clipped_len], text[0..clipped_len]);
        if (line_truncated) {
            self.display_truncated = true;
            @memcpy(display_text[clipped_len..], line_truncated_suffix);
        }
        try self.records.append(self.alloc, .{
            .number = line_number,
            .text = display_text,
        });
        self.budget.bytes = rendered_bytes;
    }
};

fn selectLinesFromContent(
    alloc: Allocator,
    content: []const u8,
    input: *const Input,
    max_line_len: usize,
    records: *std.ArrayList(LineRecord),
) !ReadScan {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(content);

    var selection = LineSelectionState{
        .alloc = alloc,
        .input = input,
        .max_line_len = max_line_len,
        .records = records,
    };
    var line_number: usize = 1;
    var total_lines: usize = 0;

    var start: usize = 0;
    while (start < content.len) : (line_number += 1) {
        const end = std.mem.findScalarPos(u8, content, start, '\n') orelse content.len;
        const line = content[start..end];
        total_lines = line_number;
        try selection.keepLine(line_number, line);
        if (end == content.len) break;
        start = end + 1;
    }

    return .{
        .total_lines = total_lines,
        .content_hash = hasher.finalResult(),
        .display_truncated = selection.display_truncated,
    };
}

fn modelViewCoversFullFile(input: *const Input, scan: ReadScan, returned_lines: usize) bool {
    return !scan.display_truncated and input.start_line == 1 and returned_lines == scan.total_lines;
}

fn recordSuccessfulRead(
    ctx: tool_dispatch.DispatchContext,
    path: []const u8,
    stat: std.Io.File.Stat,
    content_hash: read_tracker.ContentHash,
    model_view_covers_full_file: bool,
    snapshot_covers_full_file: bool,
) tool_dispatch.DispatchError!void {
    const tracker = ctx.read_tracker orelse return;
    try tracker.record(path, .{
        .mtime_ns = stat.mtime.nanoseconds,
        .content_hash = content_hash,
        .model_view_covers_full_file = model_view_covers_full_file,
        .snapshot_covers_full_file = snapshot_covers_full_file,
    });
}

fn formatReadOutput(
    alloc: Allocator,
    rel: []const u8,
    input: *const Input,
    records: []const LineRecord,
    scan: ReadScan,
    snapshot_covers_full_file: bool,
) tool_dispatch.DispatchError![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    out.writer.print("<path>{s}</path>\n<content>\n", .{rel}) catch return error.OutOfMemory;
    if (records.len > 0) {
        writeRecords(&out.writer, records) catch return error.OutOfMemory;
    } else if (scan.total_lines > 0 and input.start_line > scan.total_lines) {
        out.writer.print("... [start_line {d} is beyond end of file; total lines {d}]\n", .{ input.start_line, scan.total_lines }) catch return error.OutOfMemory;
    }

    const include_sentinel = !modelViewCoversFullFile(input, scan, records.len) or !snapshot_covers_full_file;
    if (include_sentinel and (records.len > 0 or scan.display_truncated)) {
        writeTruncationSentinel(&out.writer, records.len, scan.total_lines, snapshot_covers_full_file) catch return error.OutOfMemory;
    }
    out.writer.writeAll("</content>") catch return error.OutOfMemory;
    return try out.toOwnedSlice();
}

fn writeRecords(writer: *std.Io.Writer, records: []const LineRecord) !void {
    const width = digitCount(records[records.len - 1].number);
    try writeRecordsWithWidth(writer, records, width);
}

fn writeRecordsWithWidth(writer: *std.Io.Writer, records: []const LineRecord, width: usize) !void {
    for (records) |record| {
        try writer.print("{d}", .{record.number});
        var pad = width - digitCount(record.number);
        while (pad > 0) : (pad -= 1) try writer.writeByte(' ');
        try writer.writeByte('\t');
        try writer.writeAll(record.text);
        try writer.writeByte('\n');
    }
}

fn writeTruncationSentinel(writer: *std.Io.Writer, shown_lines: usize, total_lines: usize, snapshot_covers_full_file: bool) !void {
    if (snapshot_covers_full_file) {
        try writer.print("... [showing {d} of {d} lines; use start_line/line_count to read more.]\n", .{ shown_lines, total_lines });
    } else {
        try writer.print("... [showing {d} of at least {d} lines; file snapshot was capped before EOF.]\n", .{ shown_lines, total_lines });
    }
}

fn renderedLineBytes(width: usize, text_len: usize) usize {
    return width + 1 + text_len + 1;
}

fn freeLineRecords(alloc: Allocator, records: *std.ArrayList(LineRecord)) void {
    for (records.items) |record| alloc.free(record.text);
    records.deinit(alloc);
}

fn digitCount(value: usize) usize {
    var n = value;
    var count: usize = 1;
    while (n >= 10) : (n /= 10) count += 1;
    return count;
}

/// Reports that read_file only observes filesystem state.
pub fn readsOnly(_: tool_dispatch.ToolInput) bool {
    return true;
}

/// Reports that read_file has no irreversible side effects.
pub fn isIrreversible(_: tool_dispatch.ToolInput) bool {
    return false;
}

const read_file_dispatch_tool = tool_dispatch.Tool{
    .name = "read_file",
    .description = "Read file dispatch test fixture.",
    .model_schema = .{
        .name = "read_file",
        .description = "Read file dispatch test fixture.",
    },
    .executor_kind = .read_file,
    .activity_kind = .read,
    .permission_target_kind = .path_existing,
    .decode = decode,
    .validate = validate,
    .call = call,
    .reads_only_fn = readsOnly,
    .irreversible_fn = isIrreversible,
};

const write_file_dispatch_tool = tool_dispatch.Tool{
    .name = "write_file",
    .description = "Write file dispatch test fixture.",
    .model_schema = .{
        .name = "write_file",
        .description = "Write file dispatch test fixture.",
    },
    .executor_kind = .write_file,
    .activity_kind = .write,
    .requires_approval = true,
    .permission_target_kind = .path_create_parent,
    .decode = write_file_impl.decode,
    .validate = write_file_impl.validate,
    .call = write_file_impl.call,
    .take_file_mutation_input_fn = write_file_impl.takeFileMutationInput,
    .reads_only_fn = write_file_impl.readsOnly,
    .irreversible_fn = write_file_impl.isIrreversible,
};

fn dispatchReadFileInWorkspace(alloc: Allocator, workspace_root: []const u8, args_json: []const u8) !tool_dispatch.DispatchResult {
    const registry = tool_dispatch.Registry{ .tools = &.{read_file_dispatch_tool} };
    return tool_dispatch.dispatchToolCall(.{ .allocator = alloc, .permission_mode = .auto, .workspace_root = workspace_root }, registry, .{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = args_json,
    });
}

fn dispatchReadFile(alloc: Allocator, args_json: []const u8) !tool_dispatch.DispatchResult {
    return dispatchReadFileInWorkspace(alloc, "", args_json);
}

fn dispatchReadFileWithTrackerInWorkspace(alloc: Allocator, workspace_root: []const u8, args_json: []const u8, tracker: *read_tracker.ReadTracker) !tool_dispatch.DispatchResult {
    const registry = tool_dispatch.Registry{ .tools = &.{read_file_dispatch_tool} };
    return tool_dispatch.dispatchToolCall(.{
        .allocator = alloc,
        .permission_mode = .auto,
        .workspace_root = workspace_root,
        .read_tracker = tracker,
    }, registry, .{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = args_json,
    });
}

fn dispatchReadFileWithTracker(alloc: Allocator, args_json: []const u8, tracker: *read_tracker.ReadTracker) !tool_dispatch.DispatchResult {
    return dispatchReadFileWithTrackerInWorkspace(alloc, "", args_json, tracker);
}

fn allowDecision(_: *const tool_dispatch.Tool, _: tool_dispatch.ToolInput, _: tool_dispatch.DispatchContext) permission_gate.Decision {
    return .{ .action = .allow, .reason = "allowed by test" };
}

fn writeFileArgsJson(alloc: Allocator, path: []const u8, content: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try out.writer.writeAll("{\"path\":");
    try std.json.Stringify.value(path, .{}, &out.writer);
    try out.writer.writeAll(",\"content\":");
    try std.json.Stringify.value(content, .{}, &out.writer);
    try out.writer.writeByte('}');
    return try out.toOwnedSlice();
}

fn dispatchWriteFileWithTracker(
    alloc: Allocator,
    workspace_root: []const u8,
    path: []const u8,
    content: []const u8,
    tracker: *read_tracker.ReadTracker,
) !tool_dispatch.DispatchResult {
    const args_json = try writeFileArgsJson(alloc, path, content);
    defer alloc.free(args_json);

    const registry = tool_dispatch.Registry{ .tools = &.{write_file_dispatch_tool} };
    return tool_dispatch.dispatchToolCall(.{
        .allocator = alloc,
        .permission_mode = .auto,
        .permission_decider = allowDecision,
        .workspace_root = workspace_root,
        .read_tracker = tracker,
    }, registry, .{
        .id = "call_2",
        .name = "write_file",
        .arguments_json = args_json,
    });
}

fn tmpPath(alloc: Allocator, tmp: std.testing.TmpDir, sub_path: []const u8) ![]u8 {
    return io_mod.dirRealpathAlloc(alloc, tmp.dir, sub_path);
}

fn workspaceRoot(alloc: Allocator, tmp: std.testing.TmpDir) ![]u8 {
    return io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
}

fn readAbsolute(alloc: Allocator, path: []const u8) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io_mod.getIo(), path, .{});
    defer file.close(io_mod.getIo());
    return io_mod.readFileToEnd(alloc, &file, 1024 * 1024);
}

fn noopInputDeinit(_: *anyopaque, _: Allocator) void {}

fn validateStackInput(alloc: Allocator, input: *Input, workspace_root: []const u8) !?[]u8 {
    return validate(.{ .allocator = alloc, .workspace_root = workspace_root }, .{ .ptr = input, .deinit_fn = noopInputDeinit });
}

fn longLineText(alloc: Allocator, line_count: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    var i: usize = 0;
    while (i < line_count) : (i += 1) {
        try out.appendSlice(alloc, "x\n");
    }
    return try out.toOwnedSlice(alloc);
}

test "read_file reads workspace-relative path" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "notes");
    {
        var file = try tmp.dir.createFile(std.testing.io, "notes/today.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "hello\n");
    }
    const workspace = try workspaceRoot(alloc, tmp);
    defer alloc.free(workspace);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{"notes/today.txt"});
    defer alloc.free(args);

    const result = try dispatchReadFileInWorkspace(alloc, workspace, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expectEqualStrings("<path>notes/today.txt</path>\n<content>\n1\thello\n</content>", result.body);
    try std.testing.expect(result.tool_result_memory.?.model_view_covers_full_file.?);
}

test "read_file external absolute path preserves absolute display" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    {
        var file = try tmp.dir.createFile(std.testing.io, "external.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "outside\n");
    }
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);
    const external = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "external.txt");
    defer alloc.free(external);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{external});
    defer alloc.free(args);

    const result = try dispatchReadFileInWorkspace(alloc, workspace, args);
    defer result.deinit(std.testing.allocator);

    const expected = try std.fmt.allocPrint(alloc, "<path>{s}</path>\n<content>\n1\toutside\n</content>", .{external});
    defer alloc.free(expected);
    try std.testing.expectEqual(.success, result.status);
    try std.testing.expectEqualStrings(expected, result.body);
}

test "read_file access denial returns structured recovery" {
    const alloc = std.testing.allocator;
    const result = try readFileFailure(alloc, error.AccessDenied, "/tmp/blocked/read.txt");
    switch (result) {
        .rich => return error.TestUnexpectedRichResult,
        .failure => |body| {
            defer alloc.free(body);
            try std.testing.expect(tool_result_errors.isToolExecutionFailedOutput(body));
            try std.testing.expect(std.mem.find(u8, body, "\"tool_name\":\"read_file\"") != null);
            try std.testing.expect(std.mem.find(u8, body, "/tmp/blocked/read.txt") != null);
            try std.testing.expect(std.mem.find(u8, body, "AccessDenied") != null);
            try std.testing.expect(std.mem.find(u8, body, "symlink") != null);
        },
        .success => |body| {
            defer alloc.free(body);
            try std.testing.expect(false);
        },
    }
}

test "read_file non-regular paths return structured recovery" {
    const alloc = std.testing.allocator;
    const result = try readFileFailure(alloc, error.NotRegularFile, "/tmp/search-pipe");
    switch (result) {
        .rich => return error.TestUnexpectedRichResult,
        .failure => |body| {
            defer alloc.free(body);
            try std.testing.expect(tool_result_errors.isToolExecutionFailedOutput(body));
            try std.testing.expect(std.mem.find(u8, body, "read_file requires a regular file") != null);
            try std.testing.expect(std.mem.find(u8, body, "NotRegularFile") != null);
            try std.testing.expect(std.mem.find(u8, body, "glob_files") != null);
        },
        .success => |body| {
            defer alloc.free(body);
            try std.testing.expect(false);
        },
    }
}

test "read_file validation keeps active path-only surface" {
    const alloc = std.testing.allocator;
    var input = Input{ .path = try alloc.dupe(u8, " /tmp/report.PDF ") };
    defer input.deinit(alloc);

    try std.testing.expect((try validateStackInput(alloc, &input, "/tmp/workspace")) == null);
    try std.testing.expectEqualStrings("/tmp/report.PDF", input.path);
}

test "read_file trims leading and trailing whitespace" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "file.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "hello\n");
    }
    const path = try tmpPath(std.testing.allocator, tmp, "file.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"  {s}  \"}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    const expected = try std.fmt.allocPrint(std.testing.allocator, "<path>{s}</path>\n<content>\n1\thello\n</content>", .{path});
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, result.body);
}

test "read_file honors line range fields and uses active output shape" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "file.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "one\ntwo\nthree\n");
    }
    const path = try tmpPath(std.testing.allocator, tmp, "file.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\",\"start_line\":2,\"line_count\":2}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    const expected = try std.fmt.allocPrint(std.testing.allocator, "<path>{s}</path>\n<content>\n2\ttwo\n3\tthree\n... [showing 2 of 3 lines; use start_line/line_count to read more.]\n</content>", .{path});
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, result.body);
}

test "read_file omits binary content using active success output" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "binary.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "hello\x00world\n");
    }
    const path = try tmpPath(std.testing.allocator, tmp, "binary.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\"}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expect(std.mem.find(u8, result.body, "binary or non-utf8 file omitted") != null);
    try std.testing.expect(!result.tool_result_memory.?.model_view_covers_full_file.?);
}

test "read_file reports start_line beyond file length" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "file.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "one\ntwo\n");
    }
    const path = try tmpPath(std.testing.allocator, tmp, "file.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\",\"start_line\":5}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    const expected = try std.fmt.allocPrint(std.testing.allocator, "<path>{s}</path>\n<content>\n... [start_line 5 is beyond end of file; total lines 2]\n</content>", .{path});
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, result.body);
    try std.testing.expect(!result.tool_result_memory.?.model_view_covers_full_file.?);
}

test "read_file reports empty file as success" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "empty.txt", .{});
        defer file.close(io_mod.getIo());
    }
    const path = try tmpPath(std.testing.allocator, tmp, "empty.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\"}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    const expected = try std.fmt.allocPrint(std.testing.allocator, "<path>{s}</path>\n<content>\n</content>", .{path});
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, result.body);
}

test "read_file reports capped snapshots for oversized text files" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const bytes = try std.testing.allocator.alloc(u8, max_snapshot_file_bytes + 1);
    defer std.testing.allocator.free(bytes);
    @memset(bytes, 'x');
    {
        var file = try tmp.dir.createFile(std.testing.io, "large.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), bytes);
    }
    const path = try tmpPath(std.testing.allocator, tmp, "large.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\"}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expect(std.mem.find(u8, result.body, "file snapshot was capped before EOF") != null);
}

test "read_file sparse oversized files use active byte cap" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "too-large.txt", .{});
        defer file.close(io_mod.getIo());
        try file.setLength(io_mod.getIo(), max_snapshot_file_bytes + 1);
    }
    const path = try tmpPath(std.testing.allocator, tmp, "too-large.txt");
    defer std.testing.allocator.free(path);
    const args = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\"}}", .{path});
    defer std.testing.allocator.free(args);

    const result = try dispatchReadFile(std.testing.allocator, args);
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expect(std.mem.find(u8, result.body, "binary or non-utf8 file omitted") != null);
}

test "read_file materializes ENOENT like active tool error output" {
    const result = try dispatchReadFile(std.testing.allocator, "{\"path\":\"/tmp/handwork-core-read-file-missing\"}");
    defer result.deinit(std.testing.allocator);

    try std.testing.expectEqual(.failure, result.status);
    try std.testing.expect(std.mem.find(u8, result.body, "\"type\":\"tool_execution_failed\"") != null);
    try std.testing.expect(std.mem.find(u8, result.body, "\"tool_name\":\"read_file\"") != null);
    try std.testing.expect(std.mem.find(u8, result.body, "\"error\":\"FileNotFound\"") != null);
}

test "read_file classifiers are read-only and reversible" {
    const input = try std.testing.allocator.create(Input);
    input.* = .{ .path = try std.testing.allocator.dupe(u8, "/tmp/file.txt") };
    const erased = tool_dispatch.ToolInput{ .ptr = input, .deinit_fn = inputDeinit };
    defer erased.deinit(std.testing.allocator);

    try std.testing.expect(readsOnly(erased));
    try std.testing.expect(!isIrreversible(erased));
}

test "read_file records display-truncated reads with complete snapshot when possible" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const content = try alloc.alloc(u8, max_model_output_bytes + 128);
    defer alloc.free(content);
    @memset(content, 'a');
    {
        var file = try tmp.dir.createFile(std.testing.io, "between-caps.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), content);
    }
    const path = try tmpPath(alloc, tmp, "between-caps.txt");
    defer alloc.free(path);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{path});
    defer alloc.free(args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const result = try dispatchReadFileWithTracker(alloc, args, &tracker);
    defer result.deinit(alloc);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expect(std.mem.find(u8, result.body, line_truncated_suffix) != null);
    const record = tracker.lookup(path).?;
    try std.testing.expect(!record.model_view_covers_full_file);
    try std.testing.expect(record.snapshot_covers_full_file);
    try std.testing.expectEqualSlices(u8, &read_tracker.contentHash(content), &record.content_hash);
}

test "read_file records full coverage for files within both caps" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const content = "one\ntwo\n";
    {
        var file = try tmp.dir.createFile(std.testing.io, "small.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), content);
    }
    const path = try tmpPath(alloc, tmp, "small.txt");
    defer alloc.free(path);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{path});
    defer alloc.free(args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const result = try dispatchReadFileWithTracker(alloc, args, &tracker);
    defer result.deinit(alloc);

    try std.testing.expectEqual(.success, result.status);
    const record = tracker.lookup(path).?;
    try std.testing.expect(record.model_view_covers_full_file);
    try std.testing.expect(record.snapshot_covers_full_file);
    try std.testing.expectEqualSlices(u8, &read_tracker.contentHash(content), &record.content_hash);
}

test "read_file display budget tracks line number width growth" {
    const alloc = std.testing.allocator;
    var records: std.ArrayList(LineRecord) = .empty;
    defer freeLineRecords(alloc, &records);
    const input = Input{ .path = &.{}, .start_line = 1, .line_count = max_line_count };
    var selection = LineSelectionState{
        .alloc = alloc,
        .input = &input,
        .max_line_len = max_model_output_bytes,
        .records = &records,
    };

    try selection.keepLine(9, "aa");
    try std.testing.expect(!selection.display_truncated);
    try std.testing.expectEqual(@as(usize, 1), selection.budget.width);
    try std.testing.expectEqual(renderedLineBytes(1, "aa".len), selection.budget.bytes);

    try selection.keepLine(10, "bbb");
    try std.testing.expect(!selection.display_truncated);
    try std.testing.expectEqual(@as(usize, 2), selection.budget.width);
    try std.testing.expectEqual(renderedLineBytes(2, "aa".len) + renderedLineBytes(2, "bbb".len), selection.budget.bytes);
}

test "read_file records full-file hash for successful full read" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "file.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "one\ntwo\n");
    }
    const path = try tmpPath(alloc, tmp, "file.txt");
    defer alloc.free(path);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{path});
    defer alloc.free(args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const result = try dispatchReadFileWithTracker(alloc, args, &tracker);
    defer result.deinit(alloc);

    try std.testing.expectEqual(.success, result.status);
    const record = tracker.lookup(path).?;
    try std.testing.expect(record.model_view_covers_full_file);
    try std.testing.expect(record.snapshot_covers_full_file);
    try std.testing.expectEqualSlices(u8, &read_tracker.contentHash("one\ntwo\n"), &record.content_hash);
}

test "read_file line range fields narrow model view but preserve full snapshot" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var file = try tmp.dir.createFile(std.testing.io, "file.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "one\ntwo\nthree\n");
    }
    const path = try tmpPath(alloc, tmp, "file.txt");
    defer alloc.free(path);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\",\"start_line\":2,\"line_count\":1}}", .{path});
    defer alloc.free(args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const result = try dispatchReadFileWithTracker(alloc, args, &tracker);
    defer result.deinit(alloc);

    try std.testing.expectEqual(.success, result.status);
    const record = tracker.lookup(path).?;
    try std.testing.expect(!record.model_view_covers_full_file);
    try std.testing.expect(record.snapshot_covers_full_file);
    try std.testing.expectEqualSlices(u8, &read_tracker.contentHash("one\ntwo\nthree\n"), &record.content_hash);
}

test "read_file records capped default reads as truncated model view" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const content = try longLineText(alloc, tool_dispatch.default_max_read_file_lines + 1);
    defer alloc.free(content);
    {
        var file = try tmp.dir.createFile(std.testing.io, "long.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), content);
    }
    const path = try tmpPath(alloc, tmp, "long.txt");
    defer alloc.free(path);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{path});
    defer alloc.free(args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const result = try dispatchReadFileWithTracker(alloc, args, &tracker);
    defer result.deinit(alloc);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expect(!tracker.lookup(path).?.model_view_covers_full_file);
    try std.testing.expect(tracker.lookup(path).?.snapshot_covers_full_file);
}

test "read_file records exact default cap as full" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var content_buf: std.ArrayList(u8) = .empty;
    defer content_buf.deinit(alloc);
    var i: usize = 0;
    while (i < tool_dispatch.default_max_read_file_lines) : (i += 1) {
        if (i != 0) try content_buf.append(alloc, '\n');
        try content_buf.append(alloc, 'x');
    }
    const content = content_buf.items;
    {
        var file = try tmp.dir.createFile(std.testing.io, "exact.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), content);
    }
    const path = try tmpPath(alloc, tmp, "exact.txt");
    defer alloc.free(path);
    const args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{path});
    defer alloc.free(args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const result = try dispatchReadFileWithTracker(alloc, args, &tracker);
    defer result.deinit(alloc);

    try std.testing.expectEqual(.success, result.status);
    try std.testing.expect(tracker.lookup(path).?.model_view_covers_full_file);
    try std.testing.expect(tracker.lookup(path).?.snapshot_covers_full_file);
}

test "read_file preserves complete snapshot for truncated model view" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const content = try longLineText(alloc, tool_dispatch.default_max_read_file_lines + 1);
    defer alloc.free(content);
    {
        var file = try tmp.dir.createFile(std.testing.io, "long.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), content);
    }
    const path = try tmpPath(alloc, tmp, "long.txt");
    defer alloc.free(path);
    const read_args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{path});
    defer alloc.free(read_args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    const read_result = try dispatchReadFileWithTracker(alloc, read_args, &tracker);
    defer read_result.deinit(alloc);
    try std.testing.expectEqual(.success, read_result.status);
    try std.testing.expect(!tracker.lookup(path).?.model_view_covers_full_file);
    try std.testing.expect(tracker.lookup(path).?.snapshot_covers_full_file);

    const after = try readAbsolute(alloc, path);
    defer alloc.free(after);
    try std.testing.expectEqualStrings(content, after);
}

test "read_file records empty and beyond-end successes" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        var empty = try tmp.dir.createFile(std.testing.io, "empty.txt", .{});
        defer empty.close(io_mod.getIo());
        var file = try tmp.dir.createFile(std.testing.io, "file.txt", .{});
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "one\n");
    }
    const empty_path = try tmpPath(alloc, tmp, "empty.txt");
    defer alloc.free(empty_path);
    const file_path = try tmpPath(alloc, tmp, "file.txt");
    defer alloc.free(file_path);
    const empty_args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\"}}", .{empty_path});
    defer alloc.free(empty_args);
    const beyond_args = try std.fmt.allocPrint(alloc, "{{\"path\":\"{s}\",\"start_line\":5}}", .{file_path});
    defer alloc.free(beyond_args);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();

    var empty_result = try dispatchReadFileWithTracker(alloc, empty_args, &tracker);
    defer empty_result.deinit(alloc);
    var beyond_result = try dispatchReadFileWithTracker(alloc, beyond_args, &tracker);
    defer beyond_result.deinit(alloc);

    try std.testing.expectEqual(.success, empty_result.status);
    try std.testing.expectEqual(.success, beyond_result.status);
    const empty_record = tracker.lookup(empty_path).?;
    try std.testing.expect(empty_record.model_view_covers_full_file);
    try std.testing.expect(empty_record.snapshot_covers_full_file);
    try std.testing.expectEqualSlices(u8, &read_tracker.contentHash(""), &empty_record.content_hash);
    const beyond_record = tracker.lookup(file_path).?;
    try std.testing.expect(!beyond_record.model_view_covers_full_file);
    try std.testing.expect(beyond_record.snapshot_covers_full_file);
}

test "read_file batch preserves ranges freshness and deduplicates exact requests" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "a.txt", .data = "alpha\nbeta\ngamma\n" });
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "b.txt", .data = "delta\n" });
    const root = try workspaceRoot(alloc, tmp);
    defer alloc.free(root);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();
    const result = try dispatchReadFileWithTrackerInWorkspace(alloc, root,
        \\{"files":[{"path":"a.txt","start_line":2,"line_count":1},{"path":"b.txt"},{"path":"b.txt"}]}
    , &tracker);
    defer result.deinit(alloc);
    try std.testing.expect(std.mem.find(u8, result.body, "beta") != null);
    try std.testing.expect(std.mem.find(u8, result.body, "alpha") == null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, result.body, "delta"));
    const a = try tmpPath(alloc, tmp, "a.txt");
    defer alloc.free(a);
    const b = try tmpPath(alloc, tmp, "b.txt");
    defer alloc.free(b);
    try std.testing.expect(!tracker.lookup(a).?.model_view_covers_full_file);
    try std.testing.expect(tracker.lookup(a).?.snapshot_covers_full_file);
    try std.testing.expect(tracker.lookup(b).?.model_view_covers_full_file);
    try std.testing.expectEqual(@as(?u32, 3), result.tool_result_memory.?.read_batch_disclosed_mask);
    try std.testing.expectEqual(@as(u32, 2), result.tool_result_memory.?.read_batch_full_file_mask);
}

test "read_file batch caps disclosure before recording freshness" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "a.txt", .data = "x" ** 3000 });
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "b.txt", .data = "secret second file" });
    const root = try workspaceRoot(alloc, tmp);
    defer alloc.free(root);
    var tracker = read_tracker.ReadTracker.init(alloc);
    defer tracker.deinit();
    const registry = tool_dispatch.Registry{ .tools = &.{read_file_dispatch_tool} };
    const result = try tool_dispatch.dispatchToolCall(.{
        .allocator = alloc,
        .workspace_root = root,
        .read_tracker = &tracker,
        .max_tool_result_bytes = 1024,
        .max_read_file_bytes = 1024,
    }, registry, .{ .id = "batch", .name = "read_file", .arguments_json = "{\"files\":[{\"path\":\"a.txt\"},{\"path\":\"b.txt\"}]}" });
    defer result.deinit(alloc);
    try std.testing.expect(result.body.len <= 1024);
    const a = try tmpPath(alloc, tmp, "a.txt");
    defer alloc.free(a);
    try std.testing.expect(!tracker.lookup(a).?.model_view_covers_full_file);
}

fn batchDecodeAllocationProbe(alloc: Allocator) !void {
    const result = try decode(.{ .allocator = alloc }, "{\"files\":[{\"path\":\"a\"},{\"path\":\"b\",\"start_line\":2}]}");
    switch (result) {
        .input => |input| input.deinit(alloc),
        .failure => |body| {
            alloc.free(body);
            return error.TestUnexpectedResult;
        },
    }
}

test "read_file batch allocation failure cleanup" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, batchDecodeAllocationProbe, .{});
}

test "read_file batch rejects nested mixed and empty requests" {
    const alloc = std.testing.allocator;
    for ([_][]const u8{ "{\"files\":[]}", "{\"files\":[{\"files\":[{\"path\":\"a\"}]}]}", "{\"path\":\"a\",\"files\":[{\"path\":\"b\"}]}" }) |json| {
        const result = try decode(.{ .allocator = alloc }, json);
        switch (result) {
            .failure => |body| alloc.free(body),
            .input => |input| {
                input.deinit(alloc);
                return error.TestUnexpectedResult;
            },
        }
    }
}

test "read_file batch reuses snapshot storage across large files" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try workspaceRoot(alloc, tmp);
    defer alloc.free(root);
    var files: [8]Input = undefined;
    for (&files) |*file| file.* = .{};
    defer for (&files) |*file| file.deinit(alloc);
    for (&files, 0..) |*file, index| {
        file.path = try std.fmt.allocPrint(alloc, "{d}.txt", .{index});
        file.line_count = 1;
        try tmp.dir.writeFile(std.testing.io, .{ .sub_path = file.path, .data = "x" ** (128 * 1024) });
    }
    // Enough for a bounded output and one working snapshot, not eight snapshots.
    var buffer: [512 * 1024]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&buffer);
    const result = try callBatch(.{ .allocator = fixed.allocator(), .workspace_root = root, .max_read_file_line_len = 80 }, &files);
    defer result.deinit(fixed.allocator());
    const body = switch (result) {
        .success => |body| body,
        else => return error.TestUnexpectedResult,
    };
    try std.testing.expectEqual(@as(usize, 8), std.mem.count(u8, body, "<path>"));
}
