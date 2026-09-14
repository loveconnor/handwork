//! Shared native transport and fresh-install defaults. Provider routes live in providers.zig.
const std = @import("std");
const provider_endpoint = @import("../core/provider/provider_endpoint.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const codex = @import("../provider/openai_codex.zig");

pub const default_model = "gpt-5.6";
pub const default_chat_url = "https://chatgpt.com/backend-api/codex/responses";
pub const models_path = "https://chatgpt.com/backend-api/codex/models";
pub const retry_count: usize = 3;
pub const oauth_transport_provider = @import("../core/auth/native_oauth_transport.zig").provider;
pub const chat_url_provider = provider_endpoint.ChatUrlProvider{ .resolve_fn = resolveChatUrl };
pub const provider = provider_endpoint.Provider{
    .oauth_transport = oauth_transport_provider,
    .chat_url = chat_url_provider,
};

fn resolveChatUrl(_: ?*anyopaque, _: []const u8) []const u8 {
    return default_chat_url;
}

pub fn defaultChatUrl() []const u8 {
    return default_chat_url;
}

pub fn agentChatUrl() []const u8 {
    return default_chat_url;
}

pub fn buildAgentRequest(alloc: std.mem.Allocator, request: stream_provider.RequestData) anyerror![]u8 {
    return codex.buildRequest(alloc, request);
}

// The default native route, also used by provider-neutral test fixtures.
pub const provider_bundle = @import("providers.zig").native.codex;
pub const agent_stream_provider = codex.agent_stream_provider;
pub const model_catalog_provider = @import("../provider/openai_codex_models.zig").model_catalog_provider;
pub const cli_model_catalog_provider = @import("../provider/openai_codex_models.zig").cli_model_catalog_provider;
pub const permission_reviewer = @import("../provider/openai_codex_permission_reviewer.zig");
