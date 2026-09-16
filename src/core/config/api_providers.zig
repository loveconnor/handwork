//! Public API connection metadata. Subscription keys never fall back to API billing.
const std = @import("std");
const types = @import("../shared/types.zig");
const model_provider = @import("model_provider.zig");
pub const Entry = struct {
    id: model_provider.ProviderId,
    source: types.CredentialSource,
    key_env: [:0]const u8,
    base_env: [:0]const u8,
    model_env: [:0]const u8,
    base_url: []const u8,
    default_model: []const u8,
    anthropic: bool = false,
    anonymous: bool = false,
};
pub const entries = [_]Entry{
    .{ .id = .openai, .source = .openai_key, .key_env = "OPENAI_API_KEY", .base_env = "HANDWORK_OPENAI_BASE_URL", .model_env = "HANDWORK_OPENAI_MODEL", .base_url = "https://api.openai.com/v1", .default_model = "gpt-5.4", .anthropic = false },
    .{ .id = .anthropic, .source = .anthropic_key, .key_env = "ANTHROPIC_API_KEY", .base_env = "HANDWORK_ANTHROPIC_BASE_URL", .model_env = "HANDWORK_ANTHROPIC_MODEL", .base_url = "https://api.anthropic.com/v1", .default_model = "claude-sonnet-4-6", .anthropic = true },
    .{ .id = .gemini, .source = .gemini_key, .key_env = "GEMINI_API_KEY", .base_env = "HANDWORK_GEMINI_BASE_URL", .model_env = "HANDWORK_GEMINI_MODEL", .base_url = "https://generativelanguage.googleapis.com/v1beta/openai", .default_model = "gemini-2.5-pro", .anthropic = false },
    .{ .id = .xai, .source = .xai_key, .key_env = "XAI_API_KEY", .base_env = "HANDWORK_XAI_BASE_URL", .model_env = "HANDWORK_XAI_MODEL", .base_url = "https://api.x.ai/v1", .default_model = "grok-4", .anthropic = false },
    .{ .id = .deepseek, .source = .deepseek_key, .key_env = "DEEPSEEK_API_KEY", .base_env = "HANDWORK_DEEPSEEK_BASE_URL", .model_env = "HANDWORK_DEEPSEEK_MODEL", .base_url = "https://api.deepseek.com/v1", .default_model = "deepseek-chat", .anthropic = false },
    .{ .id = .mistral, .source = .mistral_key, .key_env = "MISTRAL_API_KEY", .base_env = "HANDWORK_MISTRAL_BASE_URL", .model_env = "HANDWORK_MISTRAL_MODEL", .base_url = "https://api.mistral.ai/v1", .default_model = "mistral-large-latest", .anthropic = false },
    .{ .id = .groq, .source = .groq_key, .key_env = "GROQ_API_KEY", .base_env = "HANDWORK_GROQ_BASE_URL", .model_env = "HANDWORK_GROQ_MODEL", .base_url = "https://api.groq.com/openai/v1", .default_model = "llama-3.3-70b-versatile", .anthropic = false },
    .{ .id = .together, .source = .together_key, .key_env = "TOGETHER_API_KEY", .base_env = "HANDWORK_TOGETHER_BASE_URL", .model_env = "HANDWORK_TOGETHER_MODEL", .base_url = "https://api.together.xyz/v1", .default_model = "meta-llama/Llama-3.3-70B-Instruct-Turbo", .anthropic = false },
    .{ .id = .fireworks, .source = .fireworks_key, .key_env = "FIREWORKS_API_KEY", .base_env = "HANDWORK_FIREWORKS_BASE_URL", .model_env = "HANDWORK_FIREWORKS_MODEL", .base_url = "https://api.fireworks.ai/inference/v1", .default_model = "accounts/fireworks/models/llama-v3p3-70b-instruct", .anthropic = false },
    .{ .id = .openrouter, .source = .openrouter_key, .key_env = "OPENROUTER_API_KEY", .base_env = "HANDWORK_OPENROUTER_BASE_URL", .model_env = "HANDWORK_OPENROUTER_MODEL", .base_url = "https://openrouter.ai/api/v1", .default_model = "openrouter/auto", .anthropic = false },
    .{ .id = .opencode, .source = .opencode_local, .key_env = "HANDWORK_OPENCODE_UNUSED_KEY", .base_env = "HANDWORK_OPENCODE_BASE_URL", .model_env = "HANDWORK_OPENCODE_MODEL", .base_url = "http://127.0.0.1:4096", .default_model = "", .anonymous = true },
    .{ .id = .minimax, .source = .minimax_key, .key_env = "MINIMAX_SUBSCRIPTION_KEY", .base_env = "HANDWORK_MINIMAX_BASE_URL", .model_env = "HANDWORK_MINIMAX_MODEL", .base_url = "https://api.minimax.io/v1", .default_model = "MiniMax-M3", .anthropic = false },
    .{ .id = .qwen, .source = .qwen_key, .key_env = "QWEN_SUBSCRIPTION_KEY", .base_env = "HANDWORK_QWEN_BASE_URL", .model_env = "HANDWORK_QWEN_MODEL", .base_url = "", .default_model = "", .anthropic = false },
    .{ .id = .ollama, .source = .ollama_local, .key_env = "HANDWORK_OLLAMA_UNUSED_KEY", .base_env = "HANDWORK_OLLAMA_BASE_URL", .model_env = "HANDWORK_OLLAMA_MODEL", .base_url = "http://localhost:11434/v1", .default_model = "", .anonymous = true },
    .{ .id = .ollama_cloud, .source = .ollama_cloud_key, .key_env = "OLLAMA_API_KEY", .base_env = "HANDWORK_OLLAMA_CLOUD_BASE_URL", .model_env = "HANDWORK_OLLAMA_CLOUD_MODEL", .base_url = "https://ollama.com/v1", .default_model = "" },
};
pub fn find(id: model_provider.ProviderId) ?*const Entry {
    for (&entries) |*entry| if (entry.id == id) return entry;
    return null;
}
pub fn forSource(source: types.CredentialSource) ?*const Entry {
    for (&entries) |*entry| if (entry.source == source) return entry;
    return null;
}
pub fn validKey(key: []const u8) bool {
    if (key.len == 0 or key.len > 8192) return false;
    for (key) |byte| if (byte <= 0x20 or byte == 0x7f) return false;
    return true;
}

pub fn validProviderKey(id: model_provider.ProviderId, key: []const u8) bool {
    if (!validKey(key)) return false;
    return switch (id) {
        .anthropic => !std.mem.startsWith(u8, key, "sk-ant-oat"),
        .minimax => std.mem.startsWith(u8, key, "sk-cp-") and key.len > 6,
        else => true,
    };
}

test "provider policy rejects consumer OAuth and wrong subscription key types" {
    try std.testing.expect(!validProviderKey(.anthropic, "sk-ant-oat01-test"));
    try std.testing.expect(validProviderKey(.anthropic, "sk-ant-api03-test"));
    try std.testing.expect(!validProviderKey(.minimax, "sk-api-test"));
    try std.testing.expect(validProviderKey(.minimax, "sk-cp-test"));
}

test "public API keys cannot cross provider or subscription billing boundaries" {
    for (&entries) |*entry| {
        try std.testing.expect(model_provider.authorizesCredential(entry.id, entry.source));
        try std.testing.expect(!model_provider.authorizesCredential(entry.id, .chatgpt_subscription));
        try std.testing.expect(!model_provider.authorizesCredential(entry.id, .grok_subscription));
        for (&entries) |*other| if (entry.id != other.id) {
            try std.testing.expect(!model_provider.authorizesCredential(entry.id, other.source));
        };
    }
    try std.testing.expect(!validKey("secret\r\nInjected: header"));
    try std.testing.expect(!validKey(""));
    try std.testing.expect(validKey("test-api-key"));
}
