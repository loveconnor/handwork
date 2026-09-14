//! Public Chat Completions and Anthropic Messages protocols.
const std = @import("std");
const stream = @import("../core/agent/stream_provider.zig");
const types = @import("../core/shared/types.zig");
const responses = @import("responses_protocol.zig");
const sse = @import("sse.zig");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
pub fn field(value: Value, key: []const u8) Value {
    return if (value == .object) value.object.get(key) orelse .null else .null;
}
pub fn string(value: Value, key: []const u8) ?[]const u8 {
    const v = field(value, key);
    return if (v == .string) v.string else null;
}
fn str(value: []const u8) Value {
    return .{ .string = value };
}
fn object(a: Allocator, keys: []const []const u8, values: []const Value) !Value {
    var out: Value = .{ .object = .empty };
    for (keys, values) |key, value| try out.object.put(a, key, value);
    return out;
}
fn array(a: Allocator) Value {
    return .{ .array = std.json.Array.init(a) };
}
fn number(v: Value) ?u64 {
    return if (v == .integer and v.integer >= 0) @intCast(v.integer) else null;
}

pub fn build(alloc: Allocator, anthropic: bool, request: stream.RequestData) ![]u8 {
    return buildWithTokenField(alloc, anthropic, request, "max_completion_tokens");
}

pub fn buildWithTokenField(alloc: Allocator, anthropic: bool, request: stream.RequestData, token_field: []const u8) ![]u8 {
    try request.validatePrompt();
    if (request.model.len == 0 or request.model.len > 256) return error.InvalidModel;
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();
    // Reuse verified image loading and tool-call ID pairing, but never carry another
    // provider's opaque reasoning or replay objects across the API boundary.
    const messages = try a.dupe(types.ChatMessage, request.messages);
    for (messages) |*message| message.provider_replay = null;
    var input: std.Io.Writer.Allocating = .init(a);
    try input.writer.writeByte('[');
    try responses.writeInput(&input.writer, a, messages, request.verified_images, .{ .tool_calls = 128, .tool_identity_bytes = 1024, .tool_arguments_bytes = 4 * 1024 * 1024, .provider_state_bytes = 4 * 1024 * 1024 }, if (request.budget) |budget| .{ .deadline = budget.deadline, .cancel_flag = budget.cancel_flag } else .{});
    try input.writer.writeByte(']');
    const normalized = try std.json.parseFromSlice(Value, a, input.written(), .{});
    var out_messages = array(a);
    var system: std.Io.Writer.Allocating = .init(a);
    for (request.instructions) |instruction| {
        if (system.written().len > 0) try system.writer.writeAll("\n\n");
        try system.writer.writeAll(instruction.content orelse "");
    }
    if (!anthropic and system.written().len > 0) try out_messages.array.append(try object(a, &.{ "role", "content" }, &.{ str("system"), str(system.written()) }));
    for (normalized.value.array.items) |item| {
        const kind = string(item, "type") orelse "";
        if (std.mem.eql(u8, kind, "function_call")) {
            const id = field(item, "call_id");
            const name = field(item, "name");
            const arguments = string(item, "arguments") orelse "{}";
            if (anthropic) {
                const args = try std.json.parseFromSlice(Value, a, arguments, .{});
                const block = try object(a, &.{ "type", "id", "name", "input" }, &.{ str("tool_use"), id, name, args.value });
                try appendAnthropic(a, &out_messages, "assistant", block);
            } else {
                const function = try object(a, &.{ "name", "arguments" }, &.{ name, str(arguments) });
                const call = try object(a, &.{ "id", "type", "function" }, &.{ id, str("function"), function });
                const last = if (out_messages.array.items.len > 0) &out_messages.array.items[out_messages.array.items.len - 1] else null;
                if (last != null and std.mem.eql(u8, string(last.?.*, "role") orelse "", "assistant")) {
                    if (!last.?.object.contains("tool_calls")) try last.?.object.put(a, "tool_calls", array(a));
                    try last.?.object.getPtr("tool_calls").?.array.append(call);
                } else {
                    var calls = array(a);
                    try calls.array.append(call);
                    try out_messages.array.append(try object(a, &.{ "role", "content", "tool_calls" }, &.{ str("assistant"), .null, calls }));
                }
            }
        } else if (std.mem.eql(u8, kind, "function_call_output")) {
            const output = field(item, "output");
            if (anthropic) {
                const content = if (output == .array) try contentParts(a, true, output) else output;
                try appendAnthropic(a, &out_messages, "user", try object(a, &.{ "type", "tool_use_id", "content" }, &.{ str("tool_result"), field(item, "call_id"), content }));
            } else {
                // Chat Completions tool messages accept text. Image-bearing tool
                // results are followed by a user image message for compatible APIs.
                var text: std.Io.Writer.Allocating = .init(a);
                if (output == .string) try text.writer.writeAll(output.string) else if (output == .array) {
                    for (output.array.items) |part| if (string(part, "text")) |value| try text.writer.writeAll(value);
                }
                try out_messages.array.append(try object(a, &.{ "role", "tool_call_id", "content" }, &.{ str("tool"), field(item, "call_id"), str(text.written()) }));
                if (output == .array) try out_messages.array.append(try object(a, &.{ "role", "content" }, &.{ str("user"), try contentParts(a, false, output) }));
            }
        } else if (string(item, "role")) |role| {
            const parts = try contentParts(a, anthropic, field(item, "content"));
            if (anthropic) {
                for (parts.array.items) |part| try appendAnthropic(a, &out_messages, role, part);
            } else try out_messages.array.append(try object(a, &.{ "role", "content" }, &.{ str(role), parts }));
        }
    }
    var root = try object(a, &.{ "model", "stream", "messages" }, &.{ str(request.model), .{ .bool = true }, out_messages });
    if (anthropic) {
        try root.object.put(a, "max_tokens", .{ .integer = request.max_output_tokens orelse 8192 });
        if (system.written().len > 0) try root.object.put(a, "system", str(system.written()));
        if (request.response_format != null) return error.StructuredOutputNotSupported;
    } else {
        try root.object.put(a, "stream_options", try object(a, &.{"include_usage"}, &.{.{ .bool = true }}));
        if (request.max_output_tokens) |limit| try root.object.put(a, token_field, .{ .integer = limit });
        if (request.response_format) |format| try root.object.put(a, "response_format", try object(a, &.{ "type", "json_schema" }, &.{ str("json_schema"), try object(a, &.{ "name", "schema", "strict" }, &.{ str(format.name), format.schema, .{ .bool = true } }) }));
    }
    var tools_json: std.Io.Writer.Allocating = .init(a);
    try tools_json.writer.writeByte('{');
    try tools_json.writer.writeAll("\"placeholder\":null");
    const count = try responses.writeTools(&tools_json.writer, a, request.tools);
    try tools_json.writer.writeByte('}');
    if (count > 0) {
        const parsed = try std.json.parseFromSlice(Value, a, tools_json.written(), .{});
        var tools = array(a);
        for (field(parsed.value, "tools").array.items) |tool| {
            if (anthropic) try tools.array.append(try object(a, &.{ "name", "description", "input_schema" }, &.{ field(tool, "name"), field(tool, "description"), field(tool, "parameters") })) else {
                const function = try object(a, &.{ "name", "description", "parameters" }, &.{ field(tool, "name"), field(tool, "description"), field(tool, "parameters") });
                try tools.array.append(try object(a, &.{ "type", "function" }, &.{ str("function"), function }));
            }
        }
        try root.object.put(a, "tools", tools);
        try root.object.put(a, "tool_choice", if (anthropic) try object(a, &.{"type"}, &.{str(if (request.tool_choice == .required) "any" else request.tool_choice.label())}) else str(request.tool_choice.label()));
    }
    return std.json.Stringify.valueAlloc(alloc, root, .{});
}

fn appendAnthropic(a: Allocator, messages: *Value, role: []const u8, block: Value) !void {
    if (messages.array.items.len > 0) {
        const last = &messages.array.items[messages.array.items.len - 1];
        if (std.mem.eql(u8, string(last.*, "role") orelse "", role)) {
            try last.object.getPtr("content").?.array.append(block);
            return;
        }
    }
    var content = array(a);
    try content.array.append(block);
    try messages.array.append(try object(a, &.{ "role", "content" }, &.{ str(role), content }));
}
fn contentParts(a: Allocator, anthropic: bool, parts: Value) !Value {
    var result = array(a);
    if (parts != .array) return result;
    for (parts.array.items) |part| {
        if (string(part, "text")) |text| {
            try result.array.append(try object(a, &.{ "type", "text" }, &.{ str("text"), str(text) }));
        } else if (string(part, "image_url")) |url| {
            if (anthropic) {
                if (!std.mem.startsWith(u8, url, "data:")) return error.UnsupportedImageUrl;
                const marker = std.mem.indexOf(u8, url, ";base64,") orelse return error.InvalidImageUrl;
                const source = try object(a, &.{ "type", "media_type", "data" }, &.{ str("base64"), str(url[5..marker]), str(url[marker + 8 ..]) });
                try result.array.append(try object(a, &.{ "type", "source" }, &.{ str("image"), source }));
            } else try result.array.append(try object(a, &.{ "type", "image_url" }, &.{ str("image_url"), try object(a, &.{"url"}, &.{str(url)}) }));
        }
    }
    return result;
}

const Pending = struct {
    id: std.ArrayList(u8) = .empty,
    name: std.ArrayList(u8) = .empty,
    args: std.ArrayList(u8) = .empty,
    started: bool = false,
    fn deinit(self: *Pending, a: Allocator) void {
        self.id.deinit(a);
        self.name.deinit(a);
        self.args.deinit(a);
    }
};
fn appendBounded(a: Allocator, out: *std.ArrayList(u8), text: []const u8, limit: usize) !void {
    if (text.len > limit -| out.items.len) return error.ProviderResponseTooLarge;
    try out.appendSlice(a, text);
}
fn updateUsage(usage: *types.Usage, value: Value, anthropic: bool) void {
    if (number(field(value, if (anthropic) "input_tokens" else "prompt_tokens"))) |n| usage.input_tokens = n;
    if (number(field(value, if (anthropic) "output_tokens" else "completion_tokens"))) |n| usage.output_tokens = n;
    if (number(field(value, "cache_read_input_tokens"))) |n| usage.cache_read_tokens = n;
    if (number(field(value, "cache_creation_input_tokens"))) |n| usage.cache_write_tokens = n;
    if (number(field(field(value, "prompt_tokens_details"), "cached_tokens"))) |n| usage.cache_read_tokens = n;
}

pub fn consume(alloc: Allocator, anthropic: bool, reader: *std.Io.Reader, events: stream.EventSink, cancelled: *std.atomic.Value(bool), capture_limit: ?usize) !stream.Result {
    var framing = sse.Reader{ .max_event_bytes = 1024 * 1024, .max_total_bytes = 64 * 1024 * 1024 };
    defer framing.deinit(alloc);
    var content: std.ArrayList(u8) = .empty;
    defer content.deinit(alloc);
    var pending: [128]Pending = .{Pending{}} ** 128;
    defer for (&pending) |*call| call.deinit(alloc);
    var usage: types.Usage = .{};
    var terminal = false;
    var finished = false;
    var finish: ?types.ProviderFinishReason = null;
    while (try framing.next(alloc, reader, cancelled)) |data| {
        if (std.mem.eql(u8, data, "[DONE]")) {
            terminal = true;
            break;
        }
        const parsed = try std.json.parseFromSlice(Value, alloc, data, .{});
        defer parsed.deinit();
        const root = parsed.value;
        if (field(root, "error") != .null or std.mem.eql(u8, string(root, "type") orelse "", "error")) return error.ProviderStreamError;
        var delta: Value = .null;
        var tool: ?*Pending = null;
        if (anthropic) {
            const kind = string(root, "type") orelse return error.InvalidProviderEvent;
            if (std.mem.eql(u8, kind, "message_start")) updateUsage(&usage, field(field(root, "message"), "usage"), true);
            if (std.mem.eql(u8, kind, "message_stop")) {
                terminal = true;
                break;
            }
            if (std.mem.eql(u8, kind, "message_delta")) {
                updateUsage(&usage, field(root, "usage"), true);
                if (string(field(root, "delta"), "stop_reason")) |reason| {
                    finished = true;
                    finish = if (std.mem.eql(u8, reason, "max_tokens")) .length else if (std.mem.eql(u8, reason, "tool_use")) .tool_calls else .stop;
                }
            }
            if (std.mem.eql(u8, kind, "content_block_start") or std.mem.eql(u8, kind, "content_block_delta")) {
                const index = number(field(root, "index")) orelse return error.InvalidToolIndex;
                if (index >= pending.len) return error.TooManyToolCalls;
                const block = field(root, "content_block");
                if (std.mem.eql(u8, string(block, "type") orelse "", "tool_use")) {
                    tool = &pending[index];
                    try appendBounded(alloc, &tool.?.id, string(block, "id") orelse "", 1024);
                    try appendBounded(alloc, &tool.?.name, string(block, "name") orelse "", 1024);
                }
                delta = field(root, "delta");
                if (string(delta, "partial_json")) |args| {
                    tool = &pending[index];
                    try appendBounded(alloc, &tool.?.args, args, 4 * 1024 * 1024);
                    events.emit(.{ .tool_input_delta = args });
                }
            }
        } else {
            updateUsage(&usage, field(root, "usage"), false);
            const choices = field(root, "choices");
            if (choices == .array and choices.array.items.len > 0) {
                const choice = choices.array.items[0];
                if (string(choice, "finish_reason")) |reason| {
                    finished = true;
                    finish = if (std.mem.eql(u8, reason, "length")) .length else if (std.mem.eql(u8, reason, "content_filter")) .content_filter else if (std.mem.eql(u8, reason, "tool_calls")) .tool_calls else .stop;
                }
                delta = field(choice, "delta");
                const calls = field(delta, "tool_calls");
                if (calls == .array) for (calls.array.items) |call| {
                    const index = number(field(call, "index")) orelse return error.InvalidToolIndex;
                    if (index >= pending.len) return error.TooManyToolCalls;
                    const target = &pending[index];
                    try appendBounded(alloc, &target.id, string(call, "id") orelse "", 1024);
                    const function = field(call, "function");
                    try appendBounded(alloc, &target.name, string(function, "name") orelse "", 1024);
                    if (string(function, "arguments")) |args| {
                        try appendBounded(alloc, &target.args, args, 4 * 1024 * 1024);
                        events.emit(.{ .tool_input_delta = args });
                    }
                    announce(events, target);
                };
            }
        }
        if (tool) |call| announce(events, call);
        if (string(delta, if (anthropic) "text" else "content")) |text| {
            events.emit(.{ .content_delta = text });
            const remaining = (capture_limit orelse (64 * 1024 * 1024)) -| content.items.len;
            try appendBounded(alloc, &content, text[0..@min(text.len, remaining)], 64 * 1024 * 1024);
        }
        if (string(delta, if (anthropic) "thinking" else "reasoning_content")) |text| events.emit(.{ .reasoning_delta = text });
    }
    if (cancelled.load(.seq_cst)) return error.Cancelled;
    if (!terminal or !finished) return error.IncompleteProviderStream;
    var calls: std.ArrayList(types.ToolCall) = .empty;
    errdefer {
        for (calls.items) |call| types.freeToolCall(alloc, call);
        calls.deinit(alloc);
    }
    for (&pending) |*call| {
        if (call.id.items.len == 0 and call.name.items.len == 0 and call.args.items.len == 0) continue;
        if (call.id.items.len == 0 or call.name.items.len == 0) return error.InvalidToolIdentity;
        for (calls.items) |prior| if (std.mem.eql(u8, prior.id, call.id.items)) return error.DuplicateToolIdentity;
        const args_text = if (call.args.items.len == 0) "{}" else call.args.items;
        const args = try std.json.parseFromSlice(Value, alloc, args_text, .{});
        defer args.deinit();
        if (args.value != .object) return error.InvalidToolArguments;
        const id = try alloc.dupe(u8, call.id.items);
        errdefer alloc.free(id);
        const name = try alloc.dupe(u8, call.name.items);
        errdefer alloc.free(name);
        const arguments = try alloc.dupe(u8, args_text);
        errdefer alloc.free(arguments);
        try calls.append(alloc, .{ .id = id, .name = name, .arguments_json = arguments });
    }
    const owned_calls = try calls.toOwnedSlice(alloc);
    errdefer types.freeToolCallSlice(alloc, owned_calls);
    return .{ .completed = .{ .completion = .{ .content = try content.toOwnedSlice(alloc), .tool_calls = owned_calls, .usage = usage, .finish_reason = finish }, .ownership = .owned, .usage = .{ .unavailable = .possibly_billed } } };
}
fn announce(events: stream.EventSink, call: *Pending) void {
    if (!call.started and call.id.items.len > 0 and call.name.items.len > 0) {
        call.started = true;
        events.emit(.{ .tool_started = .{ .id = call.id.items, .name = call.name.items } });
    }
}

const TestSink = struct {
    fn emit(_: *anyopaque, _: stream.Event) void {}
};
fn testConsume(anthropic: bool, wire: []const u8) !stream.Result {
    var reader = std.Io.Reader.fixed(wire);
    var cancelled = std.atomic.Value(bool).init(false);
    var tag: u8 = 0;
    return consume(std.testing.allocator, anthropic, &reader, .{ .context = &tag, .emit_fn = TestSink.emit }, &cancelled, null);
}
test "public API stream joins fragmented tool arguments and requires terminal proof" {
    const wire =
        "data: {\"choices\":[{\"delta\":{\"content\":\"Checking\",\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" ++
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":20}}\n\n" ++
        "data: [DONE]\n\n";
    var result = try testConsume(false, wire);
    defer result.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("Checking", result.completed.completion.content.?);
    try std.testing.expectEqualStrings("{\"path\":\"a.txt\"}", result.completed.completion.tool_calls[0].arguments_json);
    try std.testing.expectEqual(@as(?u64, 10), result.completed.completion.usage.input_tokens);
    try std.testing.expectError(error.IncompleteProviderStream, testConsume(false, wire[0 .. wire.len - "data: [DONE]\n\n".len]));
}
test "public API Anthropic stream preserves text tools and incremental usage" {
    const wire =
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\n" ++
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n" ++
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_1\",\"name\":\"read_file\",\"input\":{}}}\n\n" ++
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a\\\"}\"}}\n\n" ++
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}\n\n" ++
        "data: {\"type\":\"message_stop\"}\n\n";
    var result = try testConsume(true, wire);
    defer result.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("Hello", result.completed.completion.content.?);
    try std.testing.expectEqual(@as(usize, 1), result.completed.completion.tool_calls.len);
    try std.testing.expectEqual(@as(?u64, 7), result.completed.completion.usage.input_tokens);
    try std.testing.expectEqual(@as(?u64, 9), result.completed.completion.usage.output_tokens);
}
test "public API rejects malformed streams and invalid tool identities" {
    try std.testing.expectError(error.IncompleteProviderStream, testConsume(false, "data: [DONE]\n\n"));
    try std.testing.expectError(error.ProviderStreamError, testConsume(true, "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n"));
    try std.testing.expectError(error.InvalidToolIndex, testConsume(false, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":-1}]}}]}\n\n"));
}
test "public API request preserves instruction tool call and result lanes" {
    const a = std.testing.allocator;
    const messages = [_]types.ChatMessage{
        .{ .role = .user, .content = "Read a.txt" },
        .{ .role = .assistant, .content = "Checking", .tool_calls = &.{.{ .id = "call_a", .name = "read_file", .arguments_json = "{\"path\":\"a.txt\"}" }} },
        .{ .role = .tool, .content = "file contents", .tool_call_id = "call_a" },
    };
    for ([_]bool{ false, true }) |anthropic| {
        const body = try build(a, anthropic, .{ .model = "test-model", .messages = &messages, .instructions = &.{.{ .role = .system, .content = "instructions" }}, .tool_choice = .auto, .provider_options = .{} });
        defer a.free(body);
        const parsed = try std.json.parseFromSlice(Value, a, body, .{});
        defer parsed.deinit();
        const root = parsed.value;
        const turns = field(root, "messages").array.items;
        try std.testing.expectEqualStrings("test-model", string(root, "model").?);
        if (anthropic) {
            try std.testing.expectEqualStrings("instructions", string(root, "system").?);
            try std.testing.expectEqual(@as(usize, 3), turns.len);
            try std.testing.expectEqualStrings("tool_use", string(field(turns[1], "content").array.items[1], "type").?);
            try std.testing.expectEqualStrings("tool_result", string(field(turns[2], "content").array.items[0], "type").?);
        } else {
            try std.testing.expectEqualStrings("system", string(turns[0], "role").?);
            try std.testing.expectEqualStrings("tool", string(turns[3], "role").?);
            try std.testing.expectEqual(@as(usize, 1), field(turns[2], "tool_calls").array.items.len);
        }
        try std.testing.expect(field(root, "include") == .null);
    }
}

test "public API Ollama uses its documented output token field" {
    const a = std.testing.allocator;
    const body = try buildWithTokenField(a, false, .{ .model = "local-model", .messages = &.{.{ .role = .user, .content = "hello" }}, .instructions = &.{}, .tool_choice = .auto, .provider_options = .{}, .max_output_tokens = 123 }, "max_tokens");
    defer a.free(body);
    const parsed = try std.json.parseFromSlice(Value, a, body, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, 123), field(parsed.value, "max_tokens").integer);
    try std.testing.expect(field(parsed.value, "max_completion_tokens") == .null);
}
