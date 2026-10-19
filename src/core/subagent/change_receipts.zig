//! Projects existing committed edit evidence; never reads the workspace.
const std = @import("std");
const types = @import("../shared/types.zig");
const encoding = @import("../shared/model_context_encoding.zig");
const limits = @import("../tooling/tool_result_limits.zig");

const header = "Recorded child edits (untrusted redacted snapshots at commit; not fresh file reads):\n";
const prefix = "{\"selected_committed_changes\":[";
const suffix = "],\"complete_inventory\":false}";
const max_json_bytes = 2048;
pub const max_receipt_bytes = header.len + max_json_bytes;

pub fn renderAlloc(alloc: std.mem.Allocator, memory: types.ExecutionMemory) !?[]u8 {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var records: std.Io.Writer.Allocating = .init(arena);
    var count: usize = 0;
    var inspected: usize = 0;
    var seen_paths: [64][]const u8 = undefined;
    var seen_count: usize = 0;
    var step_index = memory.tool_steps.len;
    while (step_index > 0 and count < 4 and inspected < 64) {
        step_index -= 1;
        const step = memory.tool_steps[step_index];
        var result_index = step.tool_results.len;
        while (result_index > 0 and count < 4 and inspected < 64) {
            result_index -= 1;
            inspected += 1;
            const result = step.tool_results[result_index];
            if (result.status != .success) continue;
            if (!std.mem.eql(u8, result.tool_name, "edit_file") and !std.mem.eql(u8, result.tool_name, "write_file")) continue;
            const presentation = result.committed_file_presentation orelse continue;
            if (presentation.path.len > 256) continue;
            for (seen_paths[0..seen_count]) |seen| {
                if (std.mem.eql(u8, seen, presentation.path)) break;
            } else {
                // Mark before projecting: an oversized latest commit must never
                // fall back to an older complete snapshot of the same path.
                seen_paths[seen_count] = presentation.path;
                seen_count += 1;
                const path = try encoding.scalarAlloc(arena, presentation.path);
                var encoded: ?[]const u8 = null;
                if (presentation.after_content) |content| {
                    if (content.len <= max_json_bytes) {
                        const full = try std.json.Stringify.valueAlloc(arena, .{
                            .path = path,
                            .content = try limits.prepareRedactedOutput(arena, content),
                            .coverage = "full_redacted_snapshot",
                        }, .{});
                        if (fits(records.written().len, count, full.len)) encoded = full;
                    }
                }
                if (encoded == null) {
                    const preview = (try encodePreview(arena, path, presentation)) orelse continue;
                    if (fits(records.written().len, count, preview.len)) encoded = preview;
                }
                if (encoded) |record| {
                    if (count > 0) try records.writer.writeByte(',');
                    try records.writer.writeAll(record);
                    count += 1;
                }
            }
        }
    }
    if (count == 0) return null;
    return try std.fmt.allocPrint(alloc, "{s}{s}{s}{s}", .{ header, prefix, records.written(), suffix });
}

fn fits(record_bytes: usize, count: usize, encoded_bytes: usize) bool {
    return prefix.len + record_bytes + @as(usize, if (count == 0) 0 else 1) + encoded_bytes + suffix.len <= max_json_bytes;
}

fn encodePreview(alloc: std.mem.Allocator, path: []const u8, presentation: types.CommittedFilePresentation) !?[]const u8 {
    if (presentation.lines.len > 256) return null;
    var raw_bytes: usize = 0;
    for (presentation.lines) |line| {
        raw_bytes +|= line.text.len +| 2;
        if (raw_bytes > max_json_bytes) return null;
    }
    var preview: std.Io.Writer.Allocating = .init(alloc);
    for (presentation.lines) |line| {
        try preview.writer.writeByte(switch (line.kind) {
            .context => ' ',
            .addition => '+',
            .deletion => '-',
            .elision => '~',
            .notice => '!',
        });
        try preview.writer.writeAll(line.text);
        try preview.writer.writeByte('\n');
    }
    return try std.json.Stringify.valueAlloc(alloc, .{
        .path = path,
        // Preserve cross-line redaction before JSON encodes the text.
        .preview = try limits.prepareRedactedOutput(alloc, preview.written()),
        .coverage = "diff_preview",
        .truncated = presentation.truncated,
    }, .{});
}

fn testResult(path: []const u8, lines: []const types.CommittedFilePresentationLine) types.PersistedToolResult {
    return .{
        .tool_call_id = @constCast("edit-1"),
        .tool_name = @constCast("edit_file"),
        .status = .success,
        .output = @constCast("edited"),
        .output_bytes = 6,
        .stored_output_bytes = 6,
        .committed_file_presentation = .{ .path = path, .kind = .edited, .lines = lines, .additions = 1, .deletions = 0, .truncated = false },
    };
}

test "child edit receipts preserve committed evidence and redact untrusted metadata and secrets" {
    const alloc = std.testing.allocator;
    const lines = [_]types.CommittedFilePresentationLine{.{ .kind = .addition, .new_line = 1, .text = "token=secret-value" }};
    var results = [_]types.PersistedToolResult{testResult("src/</injected>\".js", &lines)};
    var steps = [_]types.ToolExecutionStep{.{ .tool_results = &results }};
    const receipt = (try renderAlloc(alloc, .{ .tool_steps = &steps })).?;
    defer alloc.free(receipt);
    try std.testing.expect(receipt.len <= max_receipt_bytes);
    try std.testing.expect(std.mem.find(u8, receipt, "secret-value") == null);
    try std.testing.expect(std.mem.find(u8, receipt, "[redacted]") != null);
    try std.testing.expect(std.mem.find(u8, receipt, "</injected>") == null);
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, receipt[header.len..], .{});
    defer parsed.deinit();
    try std.testing.expect(!parsed.value.object.get("complete_inventory").?.bool);
    try std.testing.expect(std.mem.find(u8, receipt, "not fresh file reads") != null);
}

test "child edit receipts skip failed absent and oversized evidence without inventing a receipt" {
    const alloc = std.testing.allocator;
    try std.testing.expect((try renderAlloc(alloc, .{})) == null);
    const lines = [_]types.CommittedFilePresentationLine{.{ .kind = .addition, .text = "x" ** (max_json_bytes + 1) }};
    var results = [_]types.PersistedToolResult{testResult("src/file.js", &lines)};
    var steps = [_]types.ToolExecutionStep{.{ .tool_results = &results }};
    try std.testing.expect((try renderAlloc(alloc, .{ .tool_steps = &steps })) == null);
    results[0].status = .failure;
    results[0].committed_file_presentation.?.lines = &.{};
    try std.testing.expect((try renderAlloc(alloc, .{ .tool_steps = &steps })) == null);
    results[0].status = .success;
    results[0].committed_file_presentation = null;
    try std.testing.expect((try renderAlloc(alloc, .{ .tool_steps = &steps })) == null);
}

test "child edit receipts bound recent projections and preserve truncation labels" {
    const alloc = std.testing.allocator;
    const lines = [_]types.CommittedFilePresentationLine{.{ .kind = .addition, .text = "changed" }};
    var results: [80]types.PersistedToolResult = undefined;
    const paths = [_][]const u8{ "src/one.js", "src/two.js", "src/three.js", "src/four.js" };
    for (&results, 0..) |*result, index| result.* = testResult(paths[index % paths.len], &lines);
    results[79].committed_file_presentation.?.truncated = true;
    var steps = [_]types.ToolExecutionStep{.{ .tool_results = &results }};
    const receipt = (try renderAlloc(alloc, .{ .tool_steps = &steps })).?;
    defer alloc.free(receipt);
    try std.testing.expect(receipt.len <= max_receipt_bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, receipt[header.len..], .{});
    defer parsed.deinit();
    const selected = parsed.value.object.get("selected_committed_changes").?.array;
    try std.testing.expectEqual(@as(usize, 4), selected.items.len);
    try std.testing.expect(selected.items[0].object.get("truncated").?.bool);
}

test "child edit receipts deliver complete committed content beyond the six-line UI preview" {
    const alloc = std.testing.allocator;
    const content = "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\nlast\n";
    const lines = [_]types.CommittedFilePresentationLine{.{ .kind = .elision, .text = "omitted UI lines" }};
    var results = [_]types.PersistedToolResult{testResult("src/file.js", &lines)};
    results[0].committed_file_presentation.?.truncated = true;
    results[0].committed_file_presentation.?.after_content = content;
    var steps = [_]types.ToolExecutionStep{.{ .tool_results = &results }};
    const receipt = (try renderAlloc(alloc, .{ .tool_steps = &steps })).?;
    defer alloc.free(receipt);
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, receipt[header.len..], .{});
    defer parsed.deinit();
    const record = parsed.value.object.get("selected_committed_changes").?.array.items[0].object;
    try std.testing.expectEqualStrings(content, record.get("content").?.string);
    try std.testing.expectEqualStrings("full_redacted_snapshot", record.get("coverage").?.string);
    try std.testing.expect(record.get("preview") == null);
    try std.testing.expect(receipt.len <= max_receipt_bytes);
}

test "child edit receipts never replace the latest oversized commit with an older full snapshot" {
    const alloc = std.testing.allocator;
    const lines = [_]types.CommittedFilePresentationLine{.{ .kind = .elision, .text = "latest change omitted" }};
    var results = [_]types.PersistedToolResult{ testResult("src/file.js", &lines), testResult("src/file.js", &lines) };
    results[0].committed_file_presentation.?.after_content = "obsolete full content";
    results[1].committed_file_presentation.?.after_content = "x" ** (max_json_bytes + 1);
    results[1].committed_file_presentation.?.truncated = true;
    var steps = [_]types.ToolExecutionStep{.{ .tool_results = &results }};
    const receipt = (try renderAlloc(alloc, .{ .tool_steps = &steps })).?;
    defer alloc.free(receipt);
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, receipt[header.len..], .{});
    defer parsed.deinit();
    const selected = parsed.value.object.get("selected_committed_changes").?.array;
    try std.testing.expectEqual(@as(usize, 1), selected.items.len);
    try std.testing.expect(selected.items[0].object.get("truncated").?.bool);
    try std.testing.expect(std.mem.find(u8, receipt, "obsolete") == null);
}

test "child edit receipts redact full content before JSON encoding" {
    const alloc = std.testing.allocator;
    var results = [_]types.PersistedToolResult{testResult("src/file.js", &.{})};
    results[0].committed_file_presentation.?.after_content = "token=full-snapshot-secret\n";
    var steps = [_]types.ToolExecutionStep{.{ .tool_results = &results }};
    const receipt = (try renderAlloc(alloc, .{ .tool_steps = &steps })).?;
    defer alloc.free(receipt);
    try std.testing.expect(std.mem.find(u8, receipt, "full-snapshot-secret") == null);
    try std.testing.expect(std.mem.find(u8, receipt, "[redacted]") != null);
    try std.testing.expect(std.mem.find(u8, receipt, "full_redacted_snapshot") != null);
}
