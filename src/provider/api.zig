//! Native public API providers. No subscription OAuth tokens or client impersonation.
const std = @import("std");
const config = @import("../core/config/api_providers.zig");
const model_provider = @import("../core/config/model_provider.zig");
const credentials = @import("../core/auth/credentials.zig");
const provider_catalog = @import("../core/auth/provider_catalog.zig");
const provider_set = @import("../core/provider/provider_set.zig");
const catalog = @import("../core/provider/model_catalog.zig");
const endpoint_types = @import("../core/provider/provider_endpoint.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const protocol = @import("api_protocol.zig");
const provider_client = @import("client.zig");
const io_mod = @import("../core/shared/io.zig");
const secret = @import("../core/auth/secret.zig");
const Allocator = std.mem.Allocator;
const max_error_body_bytes = 256 * 1024;
const transfer_buffer_bytes = 64 * 1024;
const connect_timeout_ms = 30_000;

pub fn bundle(comptime id: model_provider.ProviderId) provider_set.Bundle {
    const Adapter = struct {
        fn build(_: ?*anyopaque, alloc: Allocator, request: stream_provider.RequestData) ![]u8 {
            return protocol.buildWithTokenField(alloc, config.find(id).?.anthropic, request, if (id == .ollama or id == .ollama_cloud) "max_tokens" else "max_completion_tokens");
        }
        fn stream(_: ?*anyopaque, alloc: Allocator, original_request: stream_provider.ModelRequest) !stream_provider.Result {
            try @import("../core/config/provider_policy.zig").requireNative(id);
            var request = original_request;
            if (request.deadline == null) request.deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{ .clock = .awake, .raw = .fromSeconds(600) });
            if (!model_provider.authorizesCredential(id, request.credential.credentialSource())) return error.ProviderCredentialMismatch;
            if (request.credential.secret()) |key| {
                if (!config.validProviderKey(id, key)) return error.InvalidApiKey;
            } else return error.MissingApiKey;
            const payload = request.prepared_request_body orelse try build(null, alloc, request.data());
            defer if (request.prepared_request_body == null) alloc.free(payload);
            return streamPrepared(alloc, config.find(id).?, request, payload) catch |err| {
                if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
                request.attempt_evidence.network_failure = provider_client.networkFailureEvidence(err, request.delivery.load());
                return err;
            };
        }
        fn models(_: ?*anyopaque, alloc: Allocator, input: catalog.FetchInput) Allocator.Error!catalog.ProviderResult {
            return fetchModels(alloc, config.find(id).?, input) catch |err| {
                if (err == error.OutOfMemory) return error.OutOfMemory;
                return .{ .failure = .{ .category = if (err == error.Cancelled) .cancellation else .runtime } };
            };
        }
        fn cli(_: ?*anyopaque, alloc: Allocator, input: endpoint_types.CliModelCatalogInput) endpoint_types.CliModelCatalogResult {
            const result = models(null, alloc, .{ .access = input.access, .endpoint = input.endpoint, .cancel_flag = input.cancel_flag }) catch return .{ .failure = .{ .access = .init(input.access), .anonymous_fallback_used = false, .failure = .{ .category = .resource_exhausted } } };
            switch (result) {
                .failure => |failure| return .{ .failure = .{ .access = .init(input.access), .anonymous_fallback_used = false, .failure = failure } },
                .catalog => |value| {
                    var owned = value;
                    defer catalog.freeModelCatalog(alloc, &owned);
                    const ids = catalog.projectModelIds(alloc, owned.items) catch return .{ .failure = .{ .access = .init(input.access), .anonymous_fallback_used = false, .failure = .{ .category = .resource_exhausted } } };
                    return .{ .loaded = .{ .ids = ids, .provenance = .{ .access = .init(input.access) } } };
                },
            }
        }
    };
    return .{ .presentation = provider_catalog.find(id), .agent_stream = .{ .stream_fn = Adapter.stream, .build_request_fn = Adapter.build }, .model_catalog = .{ .fetch_fn = Adapter.models, .provider_id = id }, .cli_model_catalog = .{ .fetch_fn = Adapter.cli } };
}

pub fn baseUrl(entry: *const config.Entry) ![]const u8 {
    const base = io_mod.getenv(entry.base_env) orelse entry.base_url;
    if (!provider_client.isConfiguredServiceUrl(base)) return error.InvalidProviderBaseUrl;
    return std.mem.trimEnd(u8, base, "/");
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
    method: std.http.Method = .POST,
    uri: std.Uri,
    auth_header: ?[]const u8,
    extra_headers: []const std.http.Header,

    pub fn run(self: *@This()) !OpenedRequest {
        var headers: std.http.Client.Request.Headers = .{
            .content_type = .{ .override = "application/json" },
            .accept_encoding = .omit,
            .user_agent = .{ .override = provider_client.user_agent },
        };
        if (self.auth_header) |authorization| {
            headers.authorization = .{ .override = authorization };
        }
        return .{ .request = try self.client.request(self.method, self.uri, .{
            .headers = headers,
            .extra_headers = self.extra_headers,
            .keep_alive = false,
            .redirect_behavior = .unhandled,
        }) };
    }
};

pub fn streamPrepared(alloc: Allocator, entry: *const config.Entry, request: stream_provider.ModelRequest, payload: []const u8) !stream_provider.Result {
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
    const key = request.credential.secret() orelse return error.MissingApiKey;
    const auth = try std.fmt.allocPrint(alloc, "Bearer {s}", .{key});
    defer secret.zeroAndFree(alloc, auth);
    const url = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ try baseUrl(entry), if (entry.anthropic) "messages" else "chat/completions" });
    defer alloc.free(url);
    const uri = try std.Uri.parse(url);
    var extra_headers_buf: [3]std.http.Header = undefined;
    extra_headers_buf[0] = .{ .name = "accept", .value = "text/event-stream" };
    var extra_count: usize = 1;
    if (entry.anthropic) {
        extra_headers_buf[1] = .{ .name = "x-api-key", .value = key };
        extra_headers_buf[2] = .{ .name = "anthropic-version", .value = "2023-06-01" };
        extra_count = 3;
    }
    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();
    var open_operation = OpenRequestOperation{
        .client = &client,
        .uri = uri,
        .auth_header = if (entry.anthropic or entry.anonymous) null else auth,
        .extra_headers = extra_headers_buf[0..extra_count],
    };
    var connect_deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(connect_timeout_ms),
    });
    if (request.deadline) |deadline| {
        if (std.Io.Clock.Timestamp.compare(deadline, .lt, connect_deadline)) {
            connect_deadline = deadline;
        }
    }
    try request.admission.admit();
    var opened = try provider_client.runBoundedHttpOperation(
        OpenedRequest,
        alloc,
        request.cancel_flag,
        connect_deadline,
        &open_operation,
    );
    var http_request = opened.take();
    defer http_request.deinit();
    var cancel_watch_done = std.atomic.Value(bool).init(false);
    const cancel_watcher = if (http_request.connection) |connection|
        if (request.deadline) |deadline|
            try provider_client.spawnHttpCancelWatcherBounded(
                &cancel_watch_done,
                request.cancel_flag,
                deadline,
                connection.stream_writer.stream,
            )
        else
            try provider_client.spawnHttpCancelWatcher(
                &cancel_watch_done,
                request.cancel_flag,
                connection.stream_writer.stream,
            )
    else
        null;
    defer {
        cancel_watch_done.store(true, .seq_cst);
        if (cancel_watcher) |thread| thread.join();
    }
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    http_request.transfer_encoding = .{ .content_length = payload.len };
    var send_buffer: [8192]u8 = undefined;
    request.delivery.markPossiblySent();
    var body_writer = try http_request.sendBodyUnflushed(&send_buffer);
    try body_writer.writer.writeAll(payload);
    try body_writer.end();
    if (http_request.connection) |connection| try connection.flush();
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    var response = try http_request.receiveHead(&.{});
    if (response.head.status != .ok) {
        var transfer: [16 * 1024]u8 = undefined;
        const reader = response.reader(&transfer);
        const bounded_body = reader.allocRemaining(alloc, .limited(max_error_body_bytes + 1)) catch |err| switch (err) {
            error.StreamTooLong => try alloc.dupe(u8, "Provider error response exceeded the local limit"),
            else => return err,
        };
        const body = if (bounded_body.len > max_error_body_bytes) body: {
            alloc.free(bounded_body);
            break :body try alloc.dupe(u8, "Provider error response exceeded the local limit");
        } else bounded_body;
        return .{ .failed = .{
            .kind = failureKind(response.head.status),
            .detail = body,
            .ownership = .owned,
        } };
    }

    var transfer_buffer: [transfer_buffer_bytes]u8 = undefined;
    const reader = response.reader(&transfer_buffer);
    return protocol.consume(alloc, entry.anthropic, reader, request.events, request.cancel_flag, request.content_capture_limit);
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

fn appendModel(alloc: Allocator, list: *std.ArrayList(catalog.ModelCatalogEntry), id: []const u8) !void {
    if (id.len == 0 or id.len > 256) return;
    for (list.items) |item| if (std.mem.eql(u8, item.id, id)) return;
    const owned = try alloc.dupe(u8, id);
    errdefer alloc.free(owned);
    const kind = try alloc.dupe(u8, "language");
    errdefer alloc.free(kind);
    try list.append(alloc, .{ .id = owned, .model_type = kind, .has_tool_use = true });
}

fn fetchModels(alloc: Allocator, entry: *const config.Entry, input: catalog.FetchInput) !catalog.ProviderResult {
    try @import("../core/config/provider_policy.zig").requireNative(entry.id);
    const key = input.access.authorizationCredential() orelse return .{ .failure = .{ .category = .authentication } };
    if (input.access.credentialSource() != entry.source) return .{ .failure = .{ .category = .authentication } };
    _ = try baseUrl(entry);
    var list: std.ArrayList(catalog.ModelCatalogEntry) = .empty;
    errdefer catalog.freeModelCatalog(alloc, &list);
    // An explicit model supports providers with no model-list endpoint and private deployments.
    if (io_mod.getenv(entry.model_env)) |model| {
        try appendModel(alloc, &list, model);
        return .{ .catalog = list };
    }
    if (entry.id == .minimax or entry.id == .qwen) {
        try appendModel(alloc, &list, entry.default_model);
        return .{ .catalog = list };
    }
    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();
    const url = try std.fmt.allocPrint(alloc, "{s}/models", .{try baseUrl(entry)});
    defer alloc.free(url);
    const authorization = try std.fmt.allocPrint(alloc, "Bearer {s}", .{key});
    defer secret.zeroAndFree(alloc, authorization);
    var cancelled = std.atomic.Value(bool).init(false);
    var done = std.atomic.Value(bool).init(false);
    const cancel_flag = input.cancel_flag orelse &cancelled;
    const deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{ .clock = .awake, .raw = .fromSeconds(30) });
    var operation = OpenRequestOperation{
        .client = &client,
        .method = .GET,
        .uri = try std.Uri.parse(url),
        .auth_header = if (entry.anthropic or entry.anonymous) null else authorization,
        .extra_headers = if (entry.anthropic) &.{ .{ .name = "x-api-key", .value = key }, .{ .name = "anthropic-version", .value = "2023-06-01" } } else &.{},
    };
    var opened = try provider_client.runBoundedHttpOperation(OpenedRequest, alloc, cancel_flag, deadline, &operation);
    var request = opened.take();
    defer request.deinit();
    const watch = if (request.connection) |conn| try provider_client.spawnHttpCancelWatcherBounded(&done, input.cancel_flag orelse &cancelled, deadline, conn.stream_writer.stream) else null;
    defer {
        done.store(true, .seq_cst);
        if (watch) |thread| thread.join();
    }
    try request.sendBodiless();
    var response = try request.receiveHead(&.{});
    if (response.head.status != .ok) return .{ .failure = catalog.failureForHttpStatus(response.head.status) };
    var transfer: [8192]u8 = undefined;
    const body = try response.reader(&transfer).allocRemaining(alloc, .limited(4 * 1024 * 1024));
    defer alloc.free(body);
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    defer parsed.deinit();
    const data = protocol.field(parsed.value, "data");
    if (data != .array) return error.InvalidModelCatalog;
    for (data.array.items) |item| {
        if (list.items.len == 2048) break;
        const id = protocol.string(item, "id") orelse continue;
        if (std.mem.indexOf(u8, id, "embed") != null or std.mem.indexOf(u8, id, "whisper") != null or std.mem.indexOf(u8, id, "tts") != null or std.mem.indexOf(u8, id, "dall-e") != null) continue;
        if (entry.id == .openai and !std.mem.startsWith(u8, id, "gpt-") and !std.mem.startsWith(u8, id, "o1") and !std.mem.startsWith(u8, id, "o3") and !std.mem.startsWith(u8, id, "o4")) continue;
        if (entry.id == .openai and (std.mem.indexOf(u8, id, "realtime") != null or std.mem.indexOf(u8, id, "audio") != null or std.mem.indexOf(u8, id, "image") != null or std.mem.indexOf(u8, id, "codex") != null)) continue;
        try appendModel(alloc, &list, id);
    }
    for (list.items, 0..) |item, index| {
        if (std.mem.eql(u8, item.id, entry.default_model)) {
            std.mem.swap(catalog.ModelCatalogEntry, &list.items[0], &list.items[index]);
            break;
        }
    }
    return .{ .catalog = list };
}
