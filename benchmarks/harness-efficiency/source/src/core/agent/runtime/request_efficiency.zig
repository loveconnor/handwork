const std = @import("std");
const types = @import("../../shared/types.zig");
const trace = @import("../../shared/debug_trace.zig");
const provider = @import("../stream_provider.zig");
const io = @import("../../shared/io.zig");
const Allocator = std.mem.Allocator;

fn eligible(m: types.ChatMessage) bool {
    if (m.role != .tool or m.tool_result_status != .success or m.permission_feedback or m.images.len != 0 or m.provider_replay != null) return false;
    const name = m.tool_name orelse return false;
    if (m.tool_result_memory) |memory| {
        if (memory.truncated or memory.tool_images.len != 0 or memory.tool_image_handle != null) return false;
    }
    return std.mem.eql(u8, name, "read_file") or std.mem.eql(u8, name, "grep_files") or std.mem.eql(u8, name, "glob_files");
}

/// Request-only projection: retain the first exact result in this request and
/// replace later duplicates. Never change stored history, rerun tools, or infer
/// freshness from a previous result. Bounded lookback avoids quadratic histories.
/// Allocations belong to the caller's request arena.
pub fn project(alloc: Allocator, messages: []const types.ChatMessage, ctx: trace.TraceContext) ![]const types.ChatMessage {
    var projected: ?[]types.ChatMessage = null;
    var saved: usize = 0;
    var count: usize = 0;
    for (messages, 0..) |m, i| {
        if (!eligible(m)) continue;
        const content = m.content orelse continue;
        if (content.len < 1024) continue;
        const start = i -| 64;
        for (messages[start..i], start..) |previous, j| {
            if (!eligible(previous) or previous.tool_call_id == null or previous.content == null) continue;
            // References must point at a body that is still present, not a chain.
            if (projected) |p| if (p[j].content.?.ptr != previous.content.?.ptr) continue;
            if (!std.mem.eql(u8, m.tool_name.?, previous.tool_name.?) or !std.mem.eql(u8, content, previous.content orelse "")) continue;
            if (projected == null) projected = try alloc.dupe(types.ChatMessage, messages);
            projected.?[i].content = try std.fmt.allocPrint(alloc, "[This call completed successfully. Its output is byte-identical to the earlier {s} result with call ID {s}, retained above. Use that output for this call.]", .{ m.tool_name.?, previous.tool_call_id.? });
            saved += content.len -| projected.?[i].content.?.len;
            count += 1;
            break;
        }
    }
    if (count > 0) trace.eventf("agent", "duplicate_results_projected", ctx, "results={d} saved_bytes={d}", .{ count, saved });
    return projected orelse messages;
}

/// A hint, never a permission change or a forced extra model invocation.
/// Only identical consecutive tool failures since the latest user message count.
pub fn repeatedFailure(messages: []const types.ChatMessage) bool {
    var count: usize = 0;
    var last: ?types.ChatMessage = null;
    var i = messages.len;
    while (i > 0) {
        i -= 1;
        const m = messages[i];
        if (m.role == .user) return false;
        if (m.role != .tool) continue;
        if (m.tool_result_status != .failure or m.permission_feedback) return false;
        if (last) |previous| {
            if (!std.mem.eql(u8, m.tool_name orelse "", previous.tool_name orelse "") or
                !std.mem.eql(u8, m.content orelse "", previous.content orelse "")) return false;
        }
        last = m;
        count += 1;
        if (count == 3) return true;
    }
    return false;
}

pub const recovery_hint = "Runtime observation: the last three tool results failed with the same tool and output. Diagnose the cause and choose a materially different approach before retrying. A permission refusal remains binding; do not work around it. If no authorized path remains, report the blocker. Before claiming completion, verify the requested behavior and report unresolved failures.";

pub const Counts = struct {
    instruction_bytes: usize = 0,
    conversation_bytes: usize = 0,
    tool_result_bytes: usize = 0,
    tool_argument_bytes: usize = 0,
    replay_bytes: usize = 0,
};

pub fn measure(instructions: []const types.ChatMessage, messages: []const types.ChatMessage) Counts {
    var c: Counts = .{};
    for (instructions) |m| c.instruction_bytes += (if (m.content) |text| text.len else 0);
    for (messages) |m| {
        if (m.role == .tool) c.tool_result_bytes += (if (m.content) |text| text.len else 0) else c.conversation_bytes += (if (m.content) |text| text.len else 0);
        for (m.tool_calls) |call| c.tool_argument_bytes += call.arguments_json.len;
        if (m.provider_replay) |replay| c.replay_bytes += replay.parts_json.len;
    }
    return c;
}

/// Diagnostic text bytes, not tokenizer estimates or billing. Logs no bodies,
/// credentials, paths, or arguments. The serialized envelope includes images.
pub fn recordRequest(request: provider.ModelRequest) void {
    if (!trace.isScopeEnabled("agent")) return;
    const c = measure(request.instructions, request.messages);
    var schema_bytes: usize = 0;
    if (request.prepared_request_body) |body| {
        const parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, body, .{ .allocate = .alloc_if_needed }) catch null;
        if (parsed) |p| {
            defer p.deinit();
            if (p.value == .object) if (p.value.object.get("tools")) |value| {
                var writer: std.Io.Writer.Discarding = .init(&.{});
                std.json.Stringify.value(value, .{}, &writer.writer) catch {};
                schema_bytes = @intCast(writer.fullCount());
            };
        }
    }
    trace.eventf("agent", "request_composition", request.trace_ctx, "instruction_bytes={d} conversation_bytes={d} tool_result_bytes={d} tool_argument_bytes={d} replay_bytes={d} schema_json_bytes={d} wire_bytes={d} messages={d}", .{ c.instruction_bytes, c.conversation_bytes, c.tool_result_bytes, c.tool_argument_bytes, c.replay_bytes, schema_bytes, if (request.prepared_request_body) |b| b.len else 0, request.messages.len });
}

pub fn recordResult(request: provider.ModelRequest, result: provider.Result, started_ms: i64) void {
    const completion = switch (result) {
        .completed => |v| v.completion,
        .failed => return,
    };
    trace.eventf("agent", "request_finished", request.trace_ctx, "elapsed_ms={d} input_tokens={d} output_tokens={d} cached_input_tokens={d} usage_available={s}", .{ io.milliTimestamp() - started_ms, completion.usage.input_tokens orelse 0, completion.usage.output_tokens orelse 0, completion.usage.cache_read_tokens orelse 0, if (completion.usage.input_tokens != null) "true" else "false" });
}

test "request efficiency preserves exact evidence and only replaces successful duplicates" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const body = "abcd" ** 300;
    const first: types.ChatMessage = .{ .role = .tool, .tool_name = "read_file", .tool_call_id = "first", .tool_result_status = .success, .content = body };
    var second = first;
    second.tool_call_id = "second";
    var failed = second;
    failed.tool_result_status = .failure;
    var truncated = second;
    truncated.tool_result_memory = .{ .truncated = true };
    var changed = second;
    changed.content = "different" ** 200;
    const source = [_]types.ChatMessage{ first, second, second, failed, truncated, changed };
    const result = try project(arena.allocator(), &source, .{});
    try std.testing.expectEqualStrings(body, result[0].content.?);
    try std.testing.expect(std.mem.find(u8, result[1].content.?, "call ID first") != null);
    try std.testing.expectEqualStrings(result[1].content.?, result[2].content.?);
    try std.testing.expectEqualStrings(body, result[3].content.?);
    try std.testing.expectEqualStrings(body, result[4].content.?);
    try std.testing.expectEqualStrings(changed.content.?, result[5].content.?);
    try std.testing.expectEqualStrings(body, source[1].content.?);
    try std.testing.expectEqualStrings("second", result[1].tool_call_id.?);
}

test "request efficiency failure hint resets on progress user steering and permission feedback" {
    const failure: types.ChatMessage = .{ .role = .tool, .tool_name = "edit_file", .tool_result_status = .failure, .content = "not found" };
    try std.testing.expect(repeatedFailure(&.{ failure, failure, failure }));
    try std.testing.expect(!repeatedFailure(&.{ failure, failure }));
    try std.testing.expect(!repeatedFailure(&.{ failure, failure, .{ .role = .user, .content = "stop" }, failure }));
    var success = failure;
    success.tool_result_status = .success;
    try std.testing.expect(!repeatedFailure(&.{ failure, success, failure }));
    var denied = failure;
    denied.permission_feedback = true;
    try std.testing.expect(!repeatedFailure(&.{ failure, failure, denied }));
}

test "request efficiency composition separates instruction tool and conversation text" {
    const c = measure(&.{.{ .role = .system, .content = "abc" }}, &.{ .{ .role = .user, .content = "hello" }, .{ .role = .tool, .content = "123456" } });
    try std.testing.expectEqual(@as(usize, 3), c.instruction_bytes);
    try std.testing.expectEqual(@as(usize, 5), c.conversation_bytes);
    try std.testing.expectEqual(@as(usize, 6), c.tool_result_bytes);
}
