//! Copied into an isolated src/ tree by run.py; imports production code.
const std = @import("std");
const memory = @import("core/agent/runtime/execution_memory.zig");
const Config = @import("core/agent/runtime/config.zig").Config;
const store = @import("core/session/result_store.zig");
const children = @import("core/session/session_child_store.zig");
const replay = @import("core/session/command_replay_store.zig");
const io = @import("core/shared/io.zig");
const types = @import("core/shared/types.zig");
const Estimator = @import("core/shared/token_estimate.zig").StreamingEstimator;
const api = @import("provider/api_protocol.zig");

fn estimate(text: []const u8) u64 {
    var e = Estimator{};
    e.consume(text);
    return e.estimate();
}
fn record(name: []const u8, size: usize, text: []const u8) void {
    std.debug.print("SAVINGS,{s},{d},{d},{d}\n", .{ name, size, text.len, estimate(text) });
}

test "token savings production projection benchmark" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try tmp.dir.createDir(io.getIo(), "session", std.Io.File.Permissions.fromMode(0o700));
    var session_dir = try tmp.dir.openDir(io.getIo(), "session", .{ .iterate = true, .follow_symlinks = false });
    defer session_dir.close(io.getIo());
    const dir = try io.dirRealpathAlloc(a, tmp.dir, "session");
    var capability = try children.SessionChildCapability.initForTesting(a, session_dir, dir, .writable, .{});
    defer capability.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    const base = Config{
        .system_prompt = "",
        .provider_retry_count = 0,
        .provider_chat_url = "",
        .agent_step_limit = 1,
        .max_tool_result_bytes = 65536,
        .cancel_flag = &cancel,
        .session_child_capability = &capability,
    };
    for ([_]usize{ 4096, 8192, 12288, 16384, 32768, 65536 }) |size| {
        const raw = try a.alloc(u8, size);
        const line = "src/search/controller.ts:42: request completed with matching revision\n";
        for (raw, 0..) |*byte, i| byte.* = line[i % line.len];
        for ([_][]const u8{ "grep_files", "glob_files", "read_file", "unstored_grep", "shell" }) |name| {
            const unstored = std.mem.eql(u8, name, "unstored_grep");
            const call = types.ToolCall{ .id = "benchmark_call", .name = if (unstored) "grep_files" else name, .arguments_json = "{}" };
            var config = base;
            if (unstored) config.session_child_capability = null;
            if (std.mem.eql(u8, name, "shell")) {
                const capture = try replay.Capture.create(a, 65536, &capability);
                capture.setPolicyBeforeCapture(.required);
                try capture.appendAcceptedRequired(a, .stdout, raw);
                var prepared = try memory.prepareCapturedToolModelOutput(a, config, call, raw, capture);
                try memory.finalizeCommandReplay(a, call, &prepared, &capability, capture);
                defer capture.releaseRetained(a);
                try std.testing.expect(prepared.memory.command_output_replay != null);
                record(name, size, prepared.model_output);
            } else {
                const prepared = try memory.prepareToolModelOutput(a, config, call, raw);
                if (!unstored) {
                    const handle = prepared.memory.output_handle orelse return error.MissingHandle;
                    const recovered = try store.readByRangeManaged(a, &capability, handle, 1, store.read_max_bytes);
                    try std.testing.expect(std.mem.indexOf(u8, recovered, raw) != null);
                }
                record(name, size, prepared.model_output);
            }
        }
        const images = [_]types.ToolImage{.{ .mime_type = @constCast("image/png"), .data = @constCast("cG5n") }};
        const messages = [_]types.ChatMessage{
            .{ .role = .assistant, .tool_calls = &.{.{ .id = "capture", .name = "capture", .arguments_json = "{}" }} },
            .{ .role = .tool, .tool_call_id = "capture", .content = raw, .tool_result_memory = .{ .tool_images = &images } },
        };
        for ([_]bool{ false, true }) |anthropic| {
            const body = try api.build(a, anthropic, .{ .model = "test-model", .messages = &messages, .instructions = &.{}, .tool_choice = .auto, .provider_options = .{} });
            record(if (anthropic) "anthropic_image_request" else "chat_image_request", size, body);
        }
    }
}
