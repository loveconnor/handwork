const std = @import("std");
const jsonrpc = @import("jsonrpc.zig");
const server = @import("server.zig");
const credentials = @import("../core/auth/credentials.zig");
const provider_catalog = @import("../core/auth/provider_catalog.zig");
const api_key_store = @import("../core/auth/api_key_store.zig");
const api_providers = @import("../core/config/api_providers.zig");
const provider_policy = @import("../core/config/provider_policy.zig");
const chatgpt_oauth = @import("../core/auth/chatgpt_oauth.zig");
const grok_oauth = @import("../core/auth/grok_oauth.zig");
const model_provider = @import("../core/config/model_provider.zig");
const host_target = @import("../core/hosts/target.zig");
const io_mod = @import("../core/shared/io.zig");

const Allocator = std.mem.Allocator;
const ErrorCode = jsonrpc.ErrorCode;
const writeJsonStr = jsonrpc.writeJsonStr;

/// Desktop-facing provider management over ACP. Subscription sign-ins
/// (Codex, Grok) open a browser and are run by the client through the CLI so
/// their output never shares this JSON-RPC pipe; everything else is local
/// credential storage and answers immediately with the refreshed list.
/// Writes `{"providers":[...]}` for every native provider the engine can route.
pub fn writeProviderList(state: *server.ServerState, alloc: Allocator, w: *std.Io.Writer) !void {
    try w.writeAll("{\"providers\":[");
    var wrote = false;
    for (&provider_catalog.entries) |*entry| {
        if (comptime host_target.is_wasm) {
            if (entry.id != .codex) continue;
        }
        if (!provider_policy.nativeEnabled(entry.id)) continue;
        if (state.cfg.provider_set.select(entry.id).agent_stream == null) continue;
        // A local Ollama has no credential; the client probes its base URL to see whether it is running.
        const connected = switch (entry.login_source) {
            .ollama_local => false,
            else => credentials.sourcePresence(state.cfg.secret_store, entry.login_source) == .present,
        };
        const browser_sign_in = entry.login_source == .chatgpt_subscription or entry.login_source == .grok_subscription;
        if (wrote) try w.writeAll(",");
        wrote = true;
        try w.writeAll("{\"id\":");
        try writeJsonStr(@tagName(entry.id), w);
        try w.writeAll(",\"name\":");
        try writeJsonStr(entry.route_name, w);
        try w.writeAll(",\"description\":");
        try writeJsonStr(entry.description, w);
        try w.print(",\"connected\":{s},\"signIn\":\"{s}\"", .{ if (connected) "true" else "false", if (browser_sign_in) "browser" else if (entry.login_source == .ollama_local) "none" else "api_key" });
        if (api_providers.find(entry.id)) |api| {
            try w.writeAll(",\"keyEnv\":");
            try writeJsonStr(api.key_env, w);
            if (entry.login_source == .ollama_local) {
                try w.writeAll(",\"baseUrl\":");
                try writeJsonStr(io_mod.getenv(api.base_env) orelse api.base_url, w);
            }
        }
        try w.writeAll("}");
    }
    try w.writeAll("]}");
    _ = alloc;
}

pub fn handleList(state: *server.ServerState, alloc: Allocator, msg: *jsonrpc.Message) !void {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeProviderList(state, alloc, &out.writer);
    try state.writer.writeResponse(alloc, msg.id, out.writer.buffered());
}

const Params = struct { provider: model_provider.ProviderId, api_key: ?[]const u8 };

fn parseParams(alloc: Allocator, msg: *jsonrpc.Message) !?std.json.Parsed(std.json.Value) {
    const raw = msg.params_raw orelse return null;
    return std.json.parseFromSlice(std.json.Value, alloc, raw, .{}) catch null;
}

fn readParams(parsed: std.json.Value) ?Params {
    if (parsed != .object) return null;
    const provider_value = parsed.object.get("provider") orelse return null;
    if (provider_value != .string) return null;
    const provider = provider_catalog.parse(provider_value.string) orelse return null;
    const key = parsed.object.get("apiKey");
    return .{ .provider = provider, .api_key = if (key) |value| (if (value == .string) value.string else null) else null };
}

/// `handwork/providers/connect` stores an API key. Browser sign-ins are refused
/// here so the client runs `handwork login <provider>` instead.
pub fn handleConnect(state: *server.ServerState, alloc: Allocator, msg: *jsonrpc.Message) !void {
    const parsed = (try parseParams(alloc, msg)) orelse return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.invalid_params, .message = "Invalid params" });
    defer parsed.deinit();
    const params = readParams(parsed.value) orelse return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.invalid_params, .message = "Unknown provider" });
    const entry = provider_catalog.find(params.provider);
    switch (entry.login_source) {
        .chatgpt_subscription, .grok_subscription => return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.invalid_request, .message = "This provider signs in through the browser; run handwork login" }),
        .ollama_local => {},
        else => {
            const key = std.mem.trim(u8, params.api_key orelse "", " \t\r\n");
            if (key.len == 0) return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.invalid_params, .message = "An API key is required" });
            api_key_store.save(alloc, params.provider, key) catch |err| return state.writer.writeError(alloc, msg.id, .{
                .code = ErrorCode.invalid_params,
                .message = if (err == error.InvalidApiKey) "That key does not look valid for this provider" else "Could not save the API key",
            });
        },
    }
    try handleList(state, alloc, msg);
}

/// `handwork/providers/disconnect` removes the stored credential for a provider.
pub fn handleDisconnect(state: *server.ServerState, alloc: Allocator, msg: *jsonrpc.Message) !void {
    const parsed = (try parseParams(alloc, msg)) orelse return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.invalid_params, .message = "Invalid params" });
    defer parsed.deinit();
    const params = readParams(parsed.value) orelse return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.invalid_params, .message = "Unknown provider" });
    const entry = provider_catalog.find(params.provider);
    const failed: bool = switch (entry.login_source) {
        .chatgpt_subscription => blk: {
            _ = chatgpt_oauth.logout() catch break :blk true;
            break :blk false;
        },
        .grok_subscription => blk: {
            _ = grok_oauth.logout(alloc, state.cfg.provider_endpoint.oauth_transport) catch break :blk true;
            break :blk false;
        },
        .ollama_local => false,
        else => blk: {
            api_key_store.remove(alloc, params.provider) catch break :blk true;
            break :blk false;
        },
    };
    if (failed) return state.writer.writeError(alloc, msg.id, .{ .code = ErrorCode.internal_error, .message = "Could not remove the stored credential" });
    try handleList(state, alloc, msg);
}

test "provider params accept catalog slugs and reject unknown providers" {
    const alloc = std.testing.allocator;
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, "{\"provider\":\"anthropic\",\"apiKey\":\"sk-test\"}", .{});
    defer parsed.deinit();
    const params = readParams(parsed.value).?;
    try std.testing.expectEqual(model_provider.ProviderId.anthropic, params.provider);
    try std.testing.expectEqualStrings("sk-test", params.api_key.?);
    var unknown = try std.json.parseFromSlice(std.json.Value, alloc, "{\"provider\":\"nope\"}", .{});
    defer unknown.deinit();
    try std.testing.expect(readParams(unknown.value) == null);
}
