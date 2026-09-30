//! Synthetic local processing throughput; this does not measure model inference.
const std = @import("std");
const exports = @import("benchmark_exports");
const sse = exports.sse;
const responses = exports.responses_protocol;
const types = exports.types;

const event_count = 40_000;
const batches = 7;
const delta = "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"streamed text \\u00e9\"}";
const expected_text = "streamed text é";
const terminal = "{\"type\":\"response.completed\",\"response\":{\"id\":\"fixture\",\"status\":\"completed\"}}";
const limits: responses.StreamLimits = .{
    .aggregate_bytes = 64 * 1024 * 1024,
    .events = event_count + 1,
    .tool_calls = 128,
    .tool_identity_bytes = 1024,
    .tool_arguments_bytes = 4 * 1024 * 1024,
    .provider_state_bytes = 4 * 1024 * 1024,
};

const Capture = struct {
    bytes: usize = 0,

    fn content(ctx: *anyopaque, text: []const u8) void {
        const self: *Capture = @ptrCast(@alignCast(ctx));
        self.bytes += text.len;
    }
};

fn fixture(alloc: std.mem.Allocator, ending: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    for (0..event_count) |_| try out.writer.print("event: response.output_text.delta{s}data: {s}{s}{s}", .{ ending, delta, ending, ending });
    try out.writer.print("data: {s}{s}{s}", .{ terminal, ending, ending });
    return out.toOwnedSlice();
}

fn measure(io: std.Io, alloc: std.mem.Allocator, wire: []const u8, chunk_size: usize, reduce: bool) !u64 {
    var source = std.Io.Reader.fixed(wire);
    const buffer = try alloc.alloc(u8, chunk_size);
    defer alloc.free(buffer);
    var chunked = source.limited(.unlimited, buffer);
    var framing = sse.Reader{ .max_event_bytes = 32 * 1024 * 1024 };
    defer framing.deinit(alloc);
    var reducer = responses.Reducer.init(alloc);
    defer reducer.deinit(alloc);
    var cancelled = std.atomic.Value(bool).init(false);
    var capture: Capture = .{};
    const callbacks: responses.StreamCallbacks = .{ .context = &capture, .on_content = Capture.content };
    var count: usize = 0;
    var payload_bytes: usize = 0;
    const started = std.Io.Timestamp.now(io, .awake).nanoseconds;
    while (try framing.next(alloc, &chunked.interface, &cancelled)) |payload| {
        count += 1;
        payload_bytes += payload.len;
        if (reduce and try reducer.applyJson(alloc, payload, callbacks, &cancelled, 4096, limits)) break;
    }
    const elapsed = std.Io.Timestamp.now(io, .awake).nanoseconds - started;
    if (count != event_count + 1 or payload_bytes != event_count * delta.len + terminal.len) return error.IncorrectEventDelivery;
    if (reduce) {
        const completion = try reducer.finish(alloc, &cancelled, limits);
        defer {
            if (completion.content) |value| alloc.free(value);
            if (completion.generation_id) |value| alloc.free(value);
            if (completion.provider_state_json) |value| alloc.free(value);
            types.freeToolCallSlice(alloc, @constCast(completion.tool_calls));
        }
        if (capture.bytes != event_count * expected_text.len or completion.content.?.len != 4096) return error.IncorrectContentDelivery;
        for (completion.content.?, 0..) |byte, index| if (byte != expected_text[index % expected_text.len]) return error.IncorrectContentDelivery;
        if (!std.mem.eql(u8, completion.generation_id.?, "fixture") or completion.finish_reason.? != .stop) return error.IncorrectCompletion;
    }
    return @intCast(elapsed);
}

pub fn main(init: std.process.Init) !void {
    const alloc = std.heap.c_allocator;
    var output_buffer: [4096]u8 = undefined;
    var output = std.Io.File.stdout().writer(init.io, &output_buffer);
    for ([_][]const u8{ "\n", "\r\n" }) |ending| {
        const wire = try fixture(alloc, ending);
        defer alloc.free(wire);
        for ([_]usize{ 256 * 1024, 17 }) |chunk_size| {
            for ([_]bool{ false, true }) |reduce| {
                _ = try measure(init.io, alloc, wire, chunk_size, reduce);
                var samples: [batches]u64 = undefined;
                for (&samples) |*sample| sample.* = try measure(init.io, alloc, wire, chunk_size, reduce);
                std.mem.sort(u64, &samples, {}, std.sort.asc(u64));
                const median = samples[batches / 2];
                try output.interface.print("ending={s} chunk_bytes={d} stage={s} events={d} median_ns={d} ns_per_event={d} events_per_second={d}\n", .{
                    if (ending.len == 1) "lf" else "crlf",
                    chunk_size,
                    if (reduce) "frame_and_reduce" else "frame",
                    event_count + 1,
                    median,
                    median / (event_count + 1),
                    @as(u128, event_count + 1) * std.time.ns_per_s / @max(median, 1),
                });
                try output.interface.flush();
            }
        }
    }
}
