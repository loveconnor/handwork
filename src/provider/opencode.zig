//! Adapter for a locally running OpenCode server (`opencode serve`).
const std = @import("std");
const builtin = @import("builtin");
const api_config = @import("../core/config/api_providers.zig");
const endpoint_types = @import("../core/provider/provider_endpoint.zig");
const io_mod = @import("../core/shared/io.zig");
const model_catalog = @import("../core/provider/model_catalog.zig");
const model_provider = @import("../core/config/model_provider.zig");
const provider_catalog = @import("../core/auth/provider_catalog.zig");
const provider_client = @import("client.zig");
const provider_set = @import("../core/provider/provider_set.zig");
const responses_protocol = @import("responses_protocol.zig");
const secret = @import("../core/auth/secret.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;
const max_response_bytes = 16 * 1024 * 1024;
const max_error_body_bytes = 256 * 1024;
const transfer_buffer_bytes = 64 * 1024;
const connect_timeout_ms = 30_000;
const default_server_hostname = "127.0.0.1";
const default_server_port = "4096";
const server_start_timeout_ms = 10_000;
const server_probe_interval_ms = 50;
var server_start_mutex: std.Io.Mutex = .init;

pub fn bundle() provider_set.Bundle {
    return .{
        .presentation = provider_catalog.find(.opencode),
        .agent_stream = .{ .stream_fn = stream },
        .model_catalog = .{ .fetch_fn = fetchModels, .provider_id = .opencode, .refresh_interval_ms = 5_000 },
        .cli_model_catalog = .{ .fetch_fn = fetchCliModels },
    };
}

fn baseUrl() ![]const u8 {
    const entry = api_config.find(.opencode).?;
    const base = io_mod.getenv(entry.base_env) orelse entry.base_url;
    if (!provider_client.isConfiguredServiceUrl(base)) return error.InvalidProviderBaseUrl;
    return std.mem.trimEnd(u8, base, "/");
}

fn shouldAutoStartServer() bool {
    return io_mod.getenv(api_config.find(.opencode).?.base_env) == null;
}

fn basicAuthorization(alloc: Allocator) !?[]u8 {
    const password = io_mod.getenv("OPENCODE_SERVER_PASSWORD") orelse return null;
    const username = io_mod.getenv("OPENCODE_SERVER_USERNAME") orelse "opencode";
    const plain = try std.fmt.allocPrint(alloc, "{s}:{s}", .{ username, password });
    defer secret.zeroAndFree(alloc, plain);
    const encoded_len = std.base64.standard.Encoder.calcSize(plain.len);
    const encoded = try alloc.alloc(u8, encoded_len);
    defer secret.zeroAndFree(alloc, encoded);
    _ = std.base64.standard.Encoder.encode(encoded, plain);
    return try std.fmt.allocPrint(alloc, "Basic {s}", .{encoded});
}

const OpenedRequest = struct {
    request: ?std.http.Client.Request,

    pub fn deinit(self: *OpenedRequest, _: Allocator) void {
        if (self.request) |*request| request.deinit();
        self.request = null;
    }

    pub fn take(self: *OpenedRequest) std.http.Client.Request {
        const request = self.request.?;
        self.request = null;
        return request;
    }
};

const OpenRequestOperation = struct {
    client: *std.http.Client,
    method: std.http.Method,
    uri: std.Uri,
    auth_header: ?[]const u8,

    pub fn run(self: *@This()) !OpenedRequest {
        var headers: std.http.Client.Request.Headers = .{
            .content_type = .{ .override = "application/json" },
            .accept_encoding = .omit,
            .user_agent = .{ .override = provider_client.user_agent },
        };
        if (self.auth_header) |authorization| headers.authorization = .{ .override = authorization };
        return .{ .request = try self.client.request(self.method, self.uri, .{
            .headers = headers,
            .keep_alive = false,
            .redirect_behavior = .unhandled,
        }) };
    }
};

const HttpResponse = struct {
    status: std.http.Status,
    body: []u8,
};

fn requestJson(
    alloc: Allocator,
    method: std.http.Method,
    url: []const u8,
    body: ?[]const u8,
    auth_header: ?[]const u8,
    cancel_flag: *std.atomic.Value(bool),
    deadline: std.Io.Clock.Timestamp,
    admission: ?stream_provider.Admission,
    delivery: ?*stream_provider.DeliveryCertainty,
) !HttpResponse {
    if (cancel_flag.load(.seq_cst)) return error.Cancelled;
    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();
    var operation = OpenRequestOperation{
        .client = &client,
        .method = method,
        .uri = try std.Uri.parse(url),
        .auth_header = auth_header,
    };
    var connect_deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(connect_timeout_ms),
    });
    if (std.Io.Clock.Timestamp.compare(deadline, .lt, connect_deadline)) connect_deadline = deadline;
    if (admission) |value| try value.admit();
    var opened = try provider_client.runBoundedHttpOperation(OpenedRequest, alloc, cancel_flag, connect_deadline, &operation);
    var request = opened.take();
    defer request.deinit();

    var cancel_watch_done = std.atomic.Value(bool).init(false);
    const cancel_watcher = if (request.connection) |connection|
        try provider_client.spawnHttpCancelWatcherBounded(&cancel_watch_done, cancel_flag, deadline, connection.stream_writer.stream)
    else
        null;
    defer {
        cancel_watch_done.store(true, .seq_cst);
        if (cancel_watcher) |thread| thread.join();
    }
    if (cancel_flag.load(.seq_cst)) return error.Cancelled;

    if (body) |payload| {
        request.transfer_encoding = .{ .content_length = payload.len };
        var send_buffer: [8192]u8 = undefined;
        if (delivery) |state| state.markPossiblySent();
        var body_writer = try request.sendBodyUnflushed(&send_buffer);
        try body_writer.writer.writeAll(payload);
        try body_writer.end();
        if (request.connection) |connection| try connection.flush();
    } else {
        try request.sendBodiless();
    }
    var response = try request.receiveHead(&.{});
    var transfer_buffer: [transfer_buffer_bytes]u8 = undefined;
    const reader = response.reader(&transfer_buffer);
    const limit: usize = if (response.head.status == .ok) max_response_bytes else max_error_body_bytes;
    const response_body = reader.allocRemaining(alloc, .limited(limit + 1)) catch |err| switch (err) {
        error.StreamTooLong => return error.ProviderResponseTooLarge,
        else => return err,
    };
    if (response_body.len > limit) {
        alloc.free(response_body);
        return error.ProviderResponseTooLarge;
    }
    return .{ .status = response.head.status, .body = response_body };
}

fn reapServer(child_value: std.process.Child) void {
    var child = child_value;
    _ = child.wait(io_mod.getIo()) catch {};
}

fn startDefaultServer() !void {
    const argv = [_][]const u8{
        "opencode",
        "serve",
        "--hostname",
        default_server_hostname,
        "--port",
        default_server_port,
    };
    var child = try std.process.spawn(io_mod.getIo(), .{
        .argv = &argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = if (builtin.os.tag == .macos or builtin.os.tag == .linux) 0 else null,
    });
    const reaper = std.Thread.spawn(.{}, reapServer, .{child}) catch |err| {
        child.kill(io_mod.getIo());
        return err;
    };
    reaper.detach();
}

fn fetchProviderResponse(
    alloc: Allocator,
    url: []const u8,
    auth: ?[]const u8,
    cancel_flag: *std.atomic.Value(bool),
    deadline: std.Io.Clock.Timestamp,
) !HttpResponse {
    return requestJson(alloc, .GET, url, null, auth, cancel_flag, deadline, null, null) catch |initial_err| {
        if (initial_err == error.Cancelled or initial_err == error.OutOfMemory or !shouldAutoStartServer()) return initial_err;
        if (comptime builtin.os.tag == .wasi) return initial_err;

        server_start_mutex.lockUncancelable(io_mod.getIo());
        defer server_start_mutex.unlock(io_mod.getIo());

        if (requestJson(alloc, .GET, url, null, auth, cancel_flag, deadline, null, null)) |response| {
            return response;
        } else |retry_err| {
            if (retry_err == error.Cancelled or retry_err == error.OutOfMemory) return retry_err;
        }

        try startDefaultServer();
        const started_ms = io_mod.milliTimestamp();
        while (io_mod.milliTimestamp() - started_ms < server_start_timeout_ms) {
            if (cancel_flag.load(.seq_cst)) return error.Cancelled;
            if (requestJson(alloc, .GET, url, null, auth, cancel_flag, deadline, null, null)) |response| {
                return response;
            } else |probe_err| {
                if (probe_err == error.Cancelled or probe_err == error.OutOfMemory) return probe_err;
            }
            io_mod.sleep(server_probe_interval_ms * std.time.ns_per_ms);
        }
        return error.OpenCodeServerStartupTimeout;
    };
}

fn failureKind(status: std.http.Status) stream_provider.FailureKind {
    return switch (status) {
        .unauthorized => .unauthorized,
        .forbidden => .forbidden,
        .too_many_requests => .rate_limited,
        .bad_request => .invalid_request,
        .payload_too_large => .request_too_large,
        .internal_server_error => .server_error,
        .bad_gateway => .bad_gateway,
        .service_unavailable => .unavailable,
        .gateway_timeout => .gateway_timeout,
        else => .provider_error,
    };
}

fn failedHttp(response: HttpResponse) stream_provider.Result {
    return .{ .failed = .{
        .kind = failureKind(response.status),
        .detail = response.body,
        .ownership = .owned,
    } };
}

fn writeMessage(writer: *std.Io.Writer, message: types.ChatMessage) !void {
    try writer.writeAll("{\"role\":");
    try std.json.Stringify.value(@tagName(message.role), .{}, writer);
    if (message.content) |content| {
        try writer.writeAll(",\"content\":");
        try std.json.Stringify.value(content, .{}, writer);
    }
    if (message.tool_call_id) |id| {
        try writer.writeAll(",\"tool_call_id\":");
        try std.json.Stringify.value(id, .{}, writer);
    }
    if (message.tool_name) |name| {
        try writer.writeAll(",\"tool_name\":");
        try std.json.Stringify.value(name, .{}, writer);
    }
    if (message.tool_calls.len > 0) {
        try writer.writeAll(",\"tool_calls\":[");
        for (message.tool_calls, 0..) |call, index| {
            if (index > 0) try writer.writeByte(',');
            try writer.writeAll("{\"id\":");
            try std.json.Stringify.value(call.id, .{}, writer);
            try writer.writeAll(",\"name\":");
            try std.json.Stringify.value(call.name, .{}, writer);
            try writer.writeAll(",\"arguments\":");
            try writer.writeAll(call.arguments_json);
            try writer.writeByte('}');
        }
        try writer.writeByte(']');
    }
    if (message.images.len > 0) try writer.writeAll(",\"images_omitted\":true");
    try writer.writeByte('}');
}

fn buildTranscript(alloc: Allocator, messages: []const types.ChatMessage) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll("Continue the following conversation. The transcript is JSON:\n[");
    for (messages, 0..) |message, index| {
        if (index > 0) try out.writer.writeByte(',');
        try writeMessage(&out.writer, message);
    }
    try out.writer.writeByte(']');
    return out.toOwnedSlice();
}

fn buildSystem(alloc: Allocator, request: stream_provider.ModelRequest, tools_json: []const u8, has_tools: bool) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    for (request.instructions) |instruction| {
        if (instruction.content) |content| {
            if (out.written().len > 0) try out.writer.writeAll("\n\n");
            try out.writer.writeAll(content);
        }
    }
    if (has_tools) {
        try out.writer.writeAll(
            "\n\nHandwork, not OpenCode, owns tool execution. Return exactly one compact JSON object and no markdown. " ++
                "The object must be strict JSON with balanced braces. " ++
                "Set content to the assistant response and tool_calls to an empty array, or set content to an empty string and list the tools Handwork must execute. " ++
                "Each tool call must contain a name and an arguments object. Do not claim that a tool ran. Available tools: ",
        );
        try out.writer.writeAll(tools_json);
        if (request.tool_choice == .required) try out.writer.writeAll(" You must request at least one tool.");
    }
    return out.toOwnedSlice();
}

fn buildToolsObject(alloc: Allocator, tools: stream_provider.ToolSelection) !struct { json: []u8, count: usize } {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll("{\"placeholder\":null");
    const count = try responses_protocol.writeTools(&out.writer, alloc, tools);
    try out.writer.writeByte('}');
    return .{ .json = try out.toOwnedSlice(), .count = count };
}

fn buildMessagePayload(alloc: Allocator, request: stream_provider.ModelRequest, provider_id: []const u8, model_id: []const u8, opencode_tools: []const std.json.Value) !struct { body: []u8, has_tools: bool } {
    const tools = try buildToolsObject(alloc, request.tools);
    defer alloc.free(tools.json);
    const transcript = try buildTranscript(alloc, request.messages);
    defer alloc.free(transcript);
    const system_text = try buildSystem(alloc, request, tools.json, tools.count > 0);
    defer alloc.free(system_text);

    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    const writer = &out.writer;
    try writer.writeAll("{\"model\":{\"providerID\":");
    try std.json.Stringify.value(provider_id, .{}, writer);
    try writer.writeAll(",\"modelID\":");
    try std.json.Stringify.value(model_id, .{}, writer);
    try writer.writeAll("},\"system\":");
    try std.json.Stringify.value(system_text, .{}, writer);
    try writer.writeAll(",\"tools\":{");
    for (opencode_tools, 0..) |tool_value, index| {
        if (tool_value != .string or tool_value.string.len == 0 or tool_value.string.len > 256) return error.MalformedProviderResponse;
        if (index > 0) try writer.writeByte(',');
        try std.json.Stringify.value(tool_value.string, .{}, writer);
        try writer.writeAll(":false");
    }
    try writer.writeAll("},\"parts\":[{\"type\":\"text\",\"text\":");
    try std.json.Stringify.value(transcript, .{}, writer);
    try writer.writeAll("}]");
    if (tools.count > 0) {
        try writer.writeAll(",\"format\":{\"type\":\"text\"}");
    } else if (request.response_format) |format| {
        if (format.schema != .object) return error.InvalidStructuredResponseSchema;
        try writer.writeAll(",\"format\":{\"type\":\"json_schema\",\"schema\":");
        try std.json.Stringify.value(format.schema, .{}, writer);
        try writer.writeByte('}');
    }
    try writer.writeByte('}');
    return .{ .body = try out.toOwnedSlice(), .has_tools = tools.count > 0 };
}

fn jsonObject(value: std.json.Value) !std.json.ObjectMap {
    return switch (value) {
        .object => |object| object,
        else => error.MalformedProviderResponse,
    };
}

fn parseUsage(info: std.json.ObjectMap) types.Usage {
    const tokens_value = info.get("tokens") orelse return .{};
    const tokens = switch (tokens_value) {
        .object => |object| object,
        else => return .{},
    };
    return .{
        .input_tokens = jsonU64(tokens.get("input")),
        .output_tokens = jsonU64(tokens.get("output")),
    };
}

fn jsonU64(value: ?std.json.Value) ?u64 {
    const item = value orelse return null;
    return switch (item) {
        .integer => |number| if (number >= 0) @intCast(number) else null,
        .float => |number| if (number >= 0) @intFromFloat(number) else null,
        else => null,
    };
}

fn parseTextParts(alloc: Allocator, root: std.json.ObjectMap) !?[]u8 {
    const parts_value = root.get("parts") orelse return null;
    const parts = switch (parts_value) {
        .array => |array| array.items,
        else => return error.MalformedProviderResponse,
    };
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    for (parts) |part_value| {
        const part = try jsonObject(part_value);
        const kind = part.get("type") orelse continue;
        if (kind != .string or !std.mem.eql(u8, kind.string, "text")) continue;
        const text = part.get("text") orelse continue;
        if (text != .string) continue;
        try out.writer.writeAll(text.string);
    }
    if (out.written().len == 0) {
        out.deinit();
        return null;
    }
    return try out.toOwnedSlice();
}

fn parseToolCompletion(alloc: Allocator, structured: std.json.Value, usage: types.Usage, events: stream_provider.EventSink, message_id: []const u8) !stream_provider.Result {
    const object = try jsonObject(structured);
    var content: ?[]u8 = null;
    errdefer if (content) |value| alloc.free(value);
    if (object.get("content")) |value| if (value == .string and value.string.len > 0) {
        content = try alloc.dupe(u8, value.string);
        events.emit(.{ .content_delta = content.? });
    };

    var calls: std.ArrayList(types.ToolCall) = .empty;
    errdefer {
        for (calls.items) |call| {
            alloc.free(@constCast(call.id));
            alloc.free(@constCast(call.name));
            alloc.free(@constCast(call.arguments_json));
        }
        calls.deinit(alloc);
    }
    if (object.get("tool_calls")) |calls_value| {
        if (calls_value != .array) return error.MalformedProviderResponse;
        for (calls_value.array.items, 0..) |call_value, index| {
            const call = try jsonObject(call_value);
            const name_value = call.get("name") orelse return error.MalformedProviderResponse;
            const arguments_value = call.get("arguments") orelse return error.MalformedProviderResponse;
            if (name_value != .string or arguments_value != .object) return error.MalformedProviderResponse;
            const id = try std.fmt.allocPrint(alloc, "opencode-{s}-{d}", .{ message_id[0..@min(message_id.len, 128)], index });
            errdefer alloc.free(id);
            const name = try alloc.dupe(u8, name_value.string);
            errdefer alloc.free(name);
            const arguments = try std.json.Stringify.valueAlloc(alloc, arguments_value, .{});
            errdefer alloc.free(arguments);
            try calls.append(alloc, .{ .id = id, .name = name, .arguments_json = arguments });
            events.emit(.{ .tool_started = .{ .id = id, .name = name, .arguments_json = arguments } });
        }
    }
    const owned_calls = try calls.toOwnedSlice(alloc);
    return .{ .completed = .{
        .completion = .{
            .content = content,
            .tool_calls = owned_calls,
            .finish_reason = if (owned_calls.len > 0) .tool_calls else .stop,
            .usage = usage,
        },
        .usage = .{ .unavailable = .possibly_billed },
        .ownership = .owned,
    } };
}

fn toolEnvelopeText(text: []const u8) []const u8 {
    var trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (!std.mem.startsWith(u8, trimmed, "```")) return trimmed;
    const first_line_end = std.mem.indexOfScalar(u8, trimmed, '\n') orelse return trimmed;
    trimmed = std.mem.trim(u8, trimmed[first_line_end + 1 ..], " \t\r\n");
    if (std.mem.endsWith(u8, trimmed, "```")) {
        trimmed = std.mem.trim(u8, trimmed[0 .. trimmed.len - 3], " \t\r\n");
    }
    return trimmed;
}

fn repairJsonDelimiters(alloc: Allocator, text: []const u8) ![]u8 {
    var repaired: std.ArrayList(u8) = .empty;
    errdefer repaired.deinit(alloc);
    try repaired.ensureTotalCapacity(alloc, text.len);
    var delimiters: std.ArrayList(u8) = .empty;
    defer delimiters.deinit(alloc);
    var in_string = false;
    var escaped = false;
    for (text) |byte| {
        if (in_string) {
            try repaired.append(alloc, byte);
            if (escaped) {
                escaped = false;
            } else if (byte == '\\') {
                escaped = true;
            } else if (byte == '"') {
                in_string = false;
            }
            continue;
        }
        switch (byte) {
            '"' => {
                in_string = true;
                try repaired.append(alloc, byte);
            },
            '{', '[' => {
                try delimiters.append(alloc, byte);
                try repaired.append(alloc, byte);
            },
            '}', ']' => {
                const expected: u8 = if (byte == '}') '{' else '[';
                if (delimiters.items.len == 0 or delimiters.items[delimiters.items.len - 1] != expected) continue;
                _ = delimiters.pop();
                try repaired.append(alloc, byte);
            },
            else => try repaired.append(alloc, byte),
        }
    }
    if (in_string) return error.MalformedProviderResponse;
    while (delimiters.pop()) |opening| {
        try repaired.append(alloc, if (opening == '{') '}' else ']');
    }
    return repaired.toOwnedSlice(alloc);
}

fn parseTextToolCompletion(alloc: Allocator, root: std.json.ObjectMap, usage: types.Usage, events: stream_provider.EventSink, message_id: []const u8) !stream_provider.Result {
    const text = try parseTextParts(alloc, root) orelse return error.MalformedProviderResponse;
    defer alloc.free(text);
    const envelope = toolEnvelopeText(text);
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, envelope, .{}) catch |err| repaired: {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        const repaired_text = try repairJsonDelimiters(alloc, envelope);
        defer alloc.free(repaired_text);
        break :repaired try std.json.parseFromSlice(std.json.Value, alloc, repaired_text, .{});
    };
    defer parsed.deinit();
    return parseToolCompletion(alloc, parsed.value, usage, events, message_id);
}

fn parseCompletion(alloc: Allocator, response_body: []const u8, has_tools: bool, structured_requested: bool, events: stream_provider.EventSink) !stream_provider.Result {
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, response_body, .{});
    defer parsed.deinit();
    const root = try jsonObject(parsed.value);
    const info = try jsonObject(root.get("info") orelse return error.MalformedProviderResponse);
    if (info.get("error")) |provider_error| {
        if (provider_error != .null) {
            const detail = try std.json.Stringify.valueAlloc(alloc, provider_error, .{});
            return .{ .failed = .{ .kind = .provider_error, .detail = detail, .ownership = .owned } };
        }
    }
    const usage = parseUsage(info);
    const structured = info.get("structured") orelse info.get("structured_output");
    const message_id = if (info.get("id")) |value| if (value == .string and value.string.len > 0) value.string else "message" else "message";
    if (has_tools) {
        if (structured) |value| return parseToolCompletion(alloc, value, usage, events, message_id);
        return parseTextToolCompletion(alloc, root, usage, events, message_id);
    }

    const content = if (structured_requested)
        try std.json.Stringify.valueAlloc(alloc, structured orelse return error.MalformedProviderResponse, .{})
    else
        try parseTextParts(alloc, root);
    if (content) |text| events.emit(.{ .content_delta = text });
    return .{ .completed = .{
        .completion = .{ .content = content, .finish_reason = .stop, .usage = usage },
        .usage = .{ .unavailable = .possibly_billed },
        .ownership = .owned,
    } };
}

fn stream(_: ?*anyopaque, alloc: Allocator, original_request: stream_provider.ModelRequest) !stream_provider.Result {
    try @import("../core/config/provider_policy.zig").requireNative(.opencode);
    var request = original_request;
    if (!model_provider.authorizesCredential(.opencode, request.credential.credentialSource())) return error.ProviderCredentialMismatch;
    try request.data().validatePrompt();
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
    const separator = std.mem.indexOfScalar(u8, request.model, '/') orelse return error.InvalidProviderModel;
    if (separator == 0 or separator + 1 >= request.model.len) return error.InvalidProviderModel;
    const provider_id = request.model[0..separator];
    const model_id = request.model[separator + 1 ..];
    const auth = try basicAuthorization(alloc);
    defer if (auth) |value| secret.zeroAndFree(alloc, value);
    const deadline = request.deadline orelse std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{ .clock = .awake, .raw = .fromSeconds(600) });
    const base = try baseUrl();

    const tools_url = try std.fmt.allocPrint(alloc, "{s}/experimental/tool/ids", .{base});
    defer alloc.free(tools_url);
    const tools_response = requestJson(alloc, .GET, tools_url, null, auth, request.cancel_flag, deadline, null, null) catch |err| {
        if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
        request.attempt_evidence.network_failure = provider_client.networkFailureEvidence(err, request.delivery.load());
        return err;
    };
    if (tools_response.status != .ok) return failedHttp(tools_response);
    defer alloc.free(tools_response.body);
    var tools_json = try std.json.parseFromSlice(std.json.Value, alloc, tools_response.body, .{});
    defer tools_json.deinit();
    if (tools_json.value != .array or tools_json.value.array.items.len > 4096) return error.MalformedProviderResponse;
    const built = try buildMessagePayload(alloc, request, provider_id, model_id, tools_json.value.array.items);
    defer alloc.free(built.body);

    const create_url = try std.fmt.allocPrint(alloc, "{s}/session", .{base});
    defer alloc.free(create_url);
    const create_body = "{\"title\":\"Handwork request\"}";
    const session_response = requestJson(alloc, .POST, create_url, create_body, auth, request.cancel_flag, deadline, request.admission, request.delivery) catch |err| {
        if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
        request.attempt_evidence.network_failure = provider_client.networkFailureEvidence(err, request.delivery.load());
        return err;
    };
    if (session_response.status != .ok) return failedHttp(session_response);
    defer alloc.free(session_response.body);
    var session_json = try std.json.parseFromSlice(std.json.Value, alloc, session_response.body, .{});
    defer session_json.deinit();
    const session_object = try jsonObject(session_json.value);
    const session_id_value = session_object.get("id") orelse return error.MalformedProviderResponse;
    if (session_id_value != .string or session_id_value.string.len == 0) return error.MalformedProviderResponse;
    const message_url = try std.fmt.allocPrint(alloc, "{s}/session/{s}/message", .{ base, session_id_value.string });
    defer alloc.free(message_url);

    const message_response = requestJson(alloc, .POST, message_url, built.body, auth, request.cancel_flag, deadline, null, request.delivery) catch |err| {
        if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
        request.attempt_evidence.network_failure = provider_client.networkFailureEvidence(err, request.delivery.load());
        return err;
    };
    if (message_response.status != .ok) return failedHttp(message_response);
    defer alloc.free(message_response.body);
    const result = try parseCompletion(alloc, message_response.body, built.has_tools, request.response_format != null, request.events);
    if (!request.cancel_flag.load(.seq_cst)) {
        const session_url = std.fmt.allocPrint(alloc, "{s}/session/{s}", .{ base, session_id_value.string }) catch null;
        if (session_url) |url| {
            defer alloc.free(url);
            const cleanup: ?HttpResponse = requestJson(alloc, .DELETE, url, null, auth, request.cancel_flag, deadline, null, request.delivery) catch null;
            if (cleanup) |response| alloc.free(response.body);
        }
    }
    return result;
}

fn appendModel(alloc: Allocator, list: *std.ArrayList(model_catalog.ModelCatalogEntry), provider_id: []const u8, model_id: []const u8, model: std.json.ObjectMap) !void {
    if (provider_id.len == 0 or model_id.len == 0) return;
    const id = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ provider_id, model_id });
    errdefer alloc.free(id);
    for (list.items) |existing| if (std.mem.eql(u8, existing.id, id)) {
        alloc.free(id);
        return;
    };
    const kind = try alloc.dupe(u8, "language");
    errdefer alloc.free(kind);
    const display_name = if (model.get("name")) |name_value|
        if (name_value == .string and name_value.string.len > 0) try alloc.dupe(u8, name_value.string) else null
    else
        null;
    errdefer if (display_name) |name| alloc.free(name);
    var entry: model_catalog.ModelCatalogEntry = .{ .id = id, .display_name = display_name, .model_type = kind };
    if (model.get("capabilities")) |capabilities_value| if (capabilities_value == .object) {
        const capabilities = capabilities_value.object;
        entry.has_tool_use = jsonBool(capabilities.get("toolcall"));
        entry.has_reasoning = jsonBool(capabilities.get("reasoning"));
    };
    if (model.get("limit")) |limit_value| if (limit_value == .object) {
        entry.context_window = jsonU32(limit_value.object.get("context"));
        entry.max_tokens = jsonU32(limit_value.object.get("output"));
    };
    try list.append(alloc, entry);
}

fn jsonBool(value: ?std.json.Value) bool {
    const item = value orelse return false;
    return item == .bool and item.bool;
}

fn jsonU32(value: ?std.json.Value) u32 {
    const number = jsonU64(value) orelse return 0;
    return @intCast(@min(number, std.math.maxInt(u32)));
}

fn providerIsAvailable(connected: []const std.json.Value, provider_id: []const u8) bool {
    // OpenCode's built-in provider contains its no-setup models. Older server
    // versions can omit it from `connected` even though those models are usable.
    if (std.mem.eql(u8, provider_id, "opencode")) return true;
    for (connected) |value| if (value == .string and std.mem.eql(u8, value.string, provider_id)) return true;
    return false;
}

fn parseModels(alloc: Allocator, response_body: []const u8) !std.ArrayList(model_catalog.ModelCatalogEntry) {
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, response_body, .{});
    defer parsed.deinit();
    const root = try jsonObject(parsed.value);
    const all_value = root.get("all") orelse return error.MalformedProviderResponse;
    const connected_value = root.get("connected") orelse return error.MalformedProviderResponse;
    if (all_value != .array or connected_value != .array) return error.MalformedProviderResponse;
    var list: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &list);
    for (all_value.array.items) |provider_value| {
        const provider = try jsonObject(provider_value);
        const provider_id_value = provider.get("id") orelse continue;
        if (provider_id_value != .string or !providerIsAvailable(connected_value.array.items, provider_id_value.string)) continue;
        const models_value = provider.get("models") orelse continue;
        if (models_value != .object) continue;
        var iterator = models_value.object.iterator();
        while (iterator.next()) |model_entry| {
            if (model_entry.value_ptr.* != .object) continue;
            const model = model_entry.value_ptr.object;
            const model_id = if (model.get("id")) |id_value|
                if (id_value == .string) id_value.string else model_entry.key_ptr.*
            else
                model_entry.key_ptr.*;
            try appendModel(alloc, &list, provider_id_value.string, model_id, model);
        }
    }
    return list;
}

fn fetchModels(_: ?*anyopaque, alloc: Allocator, input: model_catalog.FetchInput) Allocator.Error!model_catalog.ProviderResult {
    @import("../core/config/provider_policy.zig").requireNative(.opencode) catch return .{ .failure = .{ .category = .runtime } };
    if (input.access.credentialSource() != .opencode_local) return .{ .failure = .{ .category = .authentication } };
    var list: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &list);
    const model_override = io_mod.getenv(api_config.find(.opencode).?.model_env);
    if (model_override != null and !shouldAutoStartServer()) {
        const model = model_override.?;
        const separator = std.mem.indexOfScalar(u8, model, '/') orelse return .{ .failure = .{ .category = .malformed_response } };
        appendModel(alloc, &list, model[0..separator], model[separator + 1 ..], .{}) catch return error.OutOfMemory;
        return .{ .catalog = list };
    }
    const auth = basicAuthorization(alloc) catch return error.OutOfMemory;
    defer if (auth) |value| secret.zeroAndFree(alloc, value);
    const url = std.fmt.allocPrint(alloc, "{s}/provider", .{baseUrl() catch return .{ .failure = .{ .category = .runtime } }}) catch return error.OutOfMemory;
    defer alloc.free(url);
    var cancelled = std.atomic.Value(bool).init(false);
    const cancel_flag = input.cancel_flag orelse &cancelled;
    const deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{ .clock = .awake, .raw = .fromSeconds(30) });
    const response = fetchProviderResponse(alloc, url, auth, cancel_flag, deadline) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = .{ .category = if (err == error.Cancelled) .cancellation else .transport, .retryable = err != error.Cancelled } };
    };
    defer alloc.free(response.body);
    if (response.status != .ok) return .{ .failure = model_catalog.failureForHttpStatus(response.status) };
    if (model_override) |model| {
        const separator = std.mem.indexOfScalar(u8, model, '/') orelse return .{ .failure = .{ .category = .malformed_response } };
        appendModel(alloc, &list, model[0..separator], model[separator + 1 ..], .{}) catch return error.OutOfMemory;
        return .{ .catalog = list };
    }
    list = parseModels(alloc, response.body) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = .{ .category = .malformed_response } };
    };
    return .{ .catalog = list };
}

fn fetchCliModels(_: ?*anyopaque, alloc: Allocator, input: endpoint_types.CliModelCatalogInput) endpoint_types.CliModelCatalogResult {
    const result = fetchModels(null, alloc, .{ .access = input.access, .endpoint = input.endpoint, .cancel_flag = input.cancel_flag }) catch return .{ .failure = .{
        .access = .init(input.access),
        .anonymous_fallback_used = false,
        .failure = .{ .category = .resource_exhausted },
    } };
    return switch (result) {
        .failure => |failure| .{ .failure = .{
            .access = .init(input.access),
            .anonymous_fallback_used = false,
            .failure = failure,
        } },
        .catalog => |catalog_value| result: {
            var owned = catalog_value;
            defer model_catalog.freeModelCatalog(alloc, &owned);
            const ids = model_catalog.projectModelIds(alloc, owned.items) catch return .{ .failure = .{
                .access = .init(input.access),
                .anonymous_fallback_used = false,
                .failure = .{ .category = .resource_exhausted },
            } };
            break :result .{ .loaded = .{ .ids = ids, .provenance = .{ .access = .init(input.access) } } };
        },
    };
}

test "local OpenCode structured output becomes a Handwork tool call" {
    const Sink = struct {
        fn emit(_: *anyopaque, _: stream_provider.Event) void {}
    };
    var tag: u8 = 0;
    var result = try parseCompletion(
        std.testing.allocator,
        "{\"info\":{\"id\":\"message-1\",\"tokens\":{\"input\":7,\"output\":3},\"structured\":{\"content\":\"\",\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{\"path\":\"README.md\"}}]}},\"parts\":[]}",
        true,
        false,
        .{ .context = &tag, .emit_fn = Sink.emit },
    );
    defer result.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), result.completed.completion.tool_calls.len);
    try std.testing.expectEqualStrings("opencode-message-1-0", result.completed.completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", result.completed.completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{\"path\":\"README.md\"}", result.completed.completion.tool_calls[0].arguments_json);
    try std.testing.expectEqual(types.ProviderFinishReason.tool_calls, result.completed.completion.finish_reason.?);
    try std.testing.expectEqual(@as(?u64, 7), result.completed.completion.usage.input_tokens);
}

test "local OpenCode text tool envelope becomes a Handwork tool call" {
    const Sink = struct {
        fn emit(_: *anyopaque, _: stream_provider.Event) void {}
    };
    const fixture =
        "{\"info\":{\"id\":\"message-2\",\"tokens\":{\"input\":5,\"output\":2}}," ++
        "\"parts\":[{\"type\":\"text\",\"text\":\"```json\\n{\\\"content\\\":\\\"\\\",\\\"tool_calls\\\":[{\\\"name\\\":\\\"read_file\\\",\\\"arguments\\\":{\\\"path\\\":\\\"package.json\\\"}}}]}\\n```\"}]}";
    var tag: u8 = 0;
    var result = try parseCompletion(
        std.testing.allocator,
        fixture,
        true,
        false,
        .{ .context = &tag, .emit_fn = Sink.emit },
    );
    defer result.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), result.completed.completion.tool_calls.len);
    try std.testing.expectEqualStrings("opencode-message-2-0", result.completed.completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", result.completed.completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{\"path\":\"package.json\"}", result.completed.completion.tool_calls[0].arguments_json);
}

test "local OpenCode provider catalog includes built-in models and connected providers" {
    const fixture =
        "{\"all\":[" ++
        "{\"id\":\"anthropic\",\"models\":{\"claude\":{\"id\":\"claude\",\"capabilities\":{\"toolcall\":true,\"reasoning\":true},\"limit\":{\"context\":200000,\"output\":8192}}}}," ++
        "{\"id\":\"opencode\",\"models\":{\"union-alpha\":{\"id\":\"union-alpha\",\"name\":\"Union Alpha Free\",\"capabilities\":{\"toolcall\":true,\"reasoning\":true}}}}," ++
        "{\"id\":\"openai\",\"models\":{\"gpt\":{\"id\":\"gpt\"}}}]," ++
        "\"connected\":[\"anthropic\"]}";
    var models = try parseModels(std.testing.allocator, fixture);
    defer model_catalog.freeModelCatalog(std.testing.allocator, &models);
    try std.testing.expectEqual(@as(usize, 2), models.items.len);
    try std.testing.expectEqualStrings("anthropic/claude", models.items[0].id);
    try std.testing.expect(models.items[0].has_tool_use);
    try std.testing.expect(models.items[0].has_reasoning);
    try std.testing.expectEqual(@as(u32, 200000), models.items[0].context_window);
    try std.testing.expectEqualStrings("opencode/union-alpha", models.items[1].id);
    try std.testing.expectEqualStrings("Union Alpha Free", models.items[1].display_name.?);
    try std.testing.expect(models.items[1].has_tool_use);
    try std.testing.expect(models.items[1].has_reasoning);
}
