const std = @import("std");
const provider = @import("../stream_provider.zig");
const types = @import("../../shared/types.zig");
const trace = @import("../../shared/debug_trace.zig");
const io_mod = @import("../../shared/io.zig");

var next_id: std.atomic.Value(u64) = .init(1);

/// Diagnostic invocation identity, not a billing identity or durable session ID.
pub fn begin(request: provider.ModelRequest) u64 {
    const id = if (comptime @import("builtin").single_threaded) blk: {
        const current = next_id.raw;
        next_id.raw +%= 1;
        break :blk current;
    } else next_id.fetchAdd(1, .monotonic);
    trace.eventf("agent", "request_attempt_started", request.trace_ctx, "request_id={d} purpose={s}", .{ id, @tagName(request.request_purpose) });
    return id;
}

pub const Counters = struct {
    input: ?u64 = null,
    output: ?u64 = null,
    cached: ?u64 = null,

    pub fn fromUsage(usage: types.Usage) Counters {
        return .{ .input = usage.input_tokens, .output = usage.output_tokens, .cached = usage.cache_read_tokens };
    }

    pub fn fromCompleted(completed: provider.Completed) Counters {
        var counters = fromUsage(completed.completion.usage);
        counters.input = completed.totalContextInput();
        return counters;
    }

    pub fn consistent(self: Counters) bool {
        if (self.cached) |cached| if (self.input) |input| return cached <= input;
        return true;
    }
};

/// One terminal record for every stream attempt, including failures and missing usage.
/// Values with known=false are absent, never measured zero. Cache is a subset of input.
/// These provider context counters do not replace the durable billing ledger.
pub fn finish(request: provider.ModelRequest, id: u64, result: ?provider.Result, started_ms: i64, admitted: bool) void {
    const counters: Counters = if (result) |r| switch (r) {
        .completed => |completed| Counters.fromCompleted(completed),
        .failed => .{},
    } else .{};
    const status: []const u8 = if (result) |r| switch (r) {
        .completed => "completed",
        .failed => "failed",
    } else "transport_failed";
    trace.eventf("agent", "request_accounting", request.trace_ctx, "request_id={d} status={s} admitted={} possibly_sent={} elapsed_ms={d} input_known={} output_known={} cache_known={} input={d} output={d} cached={d} consistent={} purpose={s}", .{ id, status, admitted, request.delivery.load() == .possibly_sent, io_mod.milliTimestamp() - started_ms, counters.input != null, counters.output != null, counters.cached != null, counters.input orelse 0, counters.output orelse 0, counters.cached orelse 0, counters.consistent(), @tagName(request.request_purpose) });
}

test "request accounting traces root and child failures without logging content or credentials" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const path = try std.fs.path.join(alloc, &.{ root, "accounting.log" });
    defer alloc.free(path);
    trace.resetForTest();
    defer trace.resetForTest();
    try trace.configureForTestWithScopes(alloc, path, "agent");
    const Callbacks = struct {
        fn event(_: *anyopaque, _: provider.Event) void {}
    };
    var context: u8 = 0;
    var cancel = std.atomic.Value(bool).init(false);
    var delivery = provider.DeliveryCertainty.init();
    var evidence: provider.AttemptEvidence = .{};
    var request: provider.ModelRequest = .{
        .credential = .{ .direct = .{ .secret_bytes = "PRIVATE_CREDENTIAL_SENTINEL" } },
        .model = "test",
        .retry_count = 1,
        .messages = &.{.{ .role = .user, .content = "PRIVATE_CONTENT_SENTINEL" }},
        .tool_choice = .auto,
        .provider_options = .{},
        .trace_ctx = .{ .turn_id = 7, .step_id = 8 },
        .content_capture_limit = null,
        .delivery = &delivery,
        .attempt_evidence = &evidence,
        .events = .{ .context = &context, .emit_fn = Callbacks.event },
        .cancel_flag = &cancel,
    };
    const first = begin(request);
    finish(request, first, .{ .completed = .{ .completion = .{ .usage = .{ .input_tokens = 0, .output_tokens = 0, .cache_read_tokens = 0 } } } }, io_mod.milliTimestamp(), true);
    request.trace_ctx.subagent_id = 3;
    request.request_purpose = .image;
    const second = begin(request);
    try std.testing.expect(first != second);
    finish(request, second, null, io_mod.milliTimestamp(), true);
    request.trace_ctx.subagent_id = 0;
    request.request_purpose = .compaction;
    const third = begin(request);
    try std.testing.expect(first != third and second != third);
    finish(request, third, .{ .completed = .{ .completion = .{ .usage = .{ .input_tokens = 1, .output_tokens = 1, .cache_read_tokens = 0 } } } }, io_mod.milliTimestamp(), true);
    var file = try std.Io.Dir.openFileAbsolute(io_mod.getIo(), path, .{});
    defer file.close(io_mod.getIo());
    const text = try io_mod.readFileToEnd(alloc, &file, 8192);
    defer alloc.free(text);
    try std.testing.expectEqual(@as(usize, 3), std.mem.count(u8, text, "event=request_attempt_started"));
    try std.testing.expectEqual(@as(usize, 3), std.mem.count(u8, text, "event=request_accounting"));
    for ([_][]const u8{ "generation", "image", "compaction" }) |purpose| {
        const marker = try std.fmt.allocPrint(alloc, "purpose={s}", .{purpose});
        defer alloc.free(marker);
        try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, text, marker));
    }
    try std.testing.expect(std.mem.find(u8, text, "input_known=true output_known=true cache_known=true input=0 output=0 cached=0") != null);
    try std.testing.expect(std.mem.find(u8, text, "input_known=false output_known=false cache_known=false") != null);
    try std.testing.expect(std.mem.find(u8, text, "subagent_id=3") != null);
    try std.testing.expect(std.mem.find(u8, text, "status=transport_failed admitted=true") != null);
    try std.testing.expect(std.mem.find(u8, text, "PRIVATE_") == null);
}

test "request accounting distinguishes missing usage from zero and cache from additional input" {
    const missing = Counters.fromUsage(.{});
    try std.testing.expect(missing.input == null);
    try std.testing.expect(missing.output == null);
    try std.testing.expect(missing.cached == null);
    const zero = Counters.fromUsage(.{ .input_tokens = 0, .output_tokens = 0, .cache_read_tokens = 0 });
    try std.testing.expectEqual(@as(?u64, 0), zero.input);
    try std.testing.expect(zero.consistent());
    const exact: Counters = .{ .input = 100, .output = 10, .cached = 60 };
    try std.testing.expect(exact.consistent());
    try std.testing.expectEqual(@as(u64, 40), exact.input.? - exact.cached.?);
    try std.testing.expect(!(Counters{ .input = 1, .cached = 2 }).consistent());
}
