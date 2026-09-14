const std = @import("std");
const types = @import("../shared/types.zig");

pub const ProviderId = enum {
    codex,
    grok,
    openai,
    anthropic,
    gemini,
    xai,
    deepseek,
    mistral,
    groq,
    together,
    fireworks,
    openrouter,
    minimax,
    qwen,
    ollama,
    ollama_cloud,
};

pub const ProviderSelection = struct {
    provider: ProviderId,
    model: []const u8,
};

pub fn parse(value: []const u8) ?ProviderId {
    if (std.ascii.eqlIgnoreCase(value, "codex")) return .codex;
    if (std.ascii.eqlIgnoreCase(value, "grok")) return .grok;
    inline for (std.meta.fields(ProviderId)) |field| {
        if (std.ascii.eqlIgnoreCase(value, field.name)) return @enumFromInt(field.value);
    }
    return null;
}

pub fn authorizesCredential(provider: ProviderId, source: ?types.CredentialSource) bool {
    const selected = source orelse return false;
    if (selected == .host_managed) return true;
    return switch (provider) {
        .codex => selected == .chatgpt_subscription,
        .grok => selected == .grok_subscription,
        .openai => selected == .openai_key,
        .anthropic => selected == .anthropic_key,
        .gemini => selected == .gemini_key,
        .xai => selected == .xai_key,
        .deepseek => selected == .deepseek_key,
        .mistral => selected == .mistral_key,
        .groq => selected == .groq_key,
        .together => selected == .together_key,
        .fireworks => selected == .fireworks_key,
        .openrouter => selected == .openrouter_key,
        .minimax => selected == .minimax_key,
        .qwen => selected == .qwen_key,
        .ollama => selected == .ollama_local,
        .ollama_cloud => selected == .ollama_cloud_key,
    };
}

test "explicit providers authorize only their own credential origins" {
    try std.testing.expect(authorizesCredential(.codex, .chatgpt_subscription));
    try std.testing.expect(!authorizesCredential(.codex, .grok_subscription));
    try std.testing.expect(!authorizesCredential(.codex, null));
    try std.testing.expect(authorizesCredential(.grok, .grok_subscription));
    try std.testing.expect(!authorizesCredential(.grok, .chatgpt_subscription));
    try std.testing.expect(authorizesCredential(.codex, .host_managed));
    try std.testing.expect(authorizesCredential(.grok, .host_managed));
}

test "provider parsing accepts subscriptions and rejects the removed provider" {
    try std.testing.expectEqual(ProviderId.codex, parse("CODEX").?);
    try std.testing.expectEqual(ProviderId.grok, parse("GROK").?);
    try std.testing.expect(parse("openai-codex") == null);
    try std.testing.expect(parse("") == null);
}
