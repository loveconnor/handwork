const std = @import("std");
const model_provider = @import("../config/model_provider.zig");
const types = @import("../shared/types.zig");

pub const Entry = struct {
    id: model_provider.ProviderId,
    slug: []const u8,
    aliases: []const []const u8 = &.{},
    name: []const u8,
    route_name: []const u8,
    description: []const u8,
    subscription: bool,
    login_source: types.CredentialSource,
};

pub const entries = [_]Entry{
    .{
        .id = .codex,
        .slug = "codex",
        .name = "Codex",
        .route_name = "Codex subscription",
        .description = "ChatGPT Plus, Pro, Business, Enterprise, or Edu subscription",
        .subscription = true,
        .login_source = .chatgpt_subscription,
    },
    .{
        .id = .grok,
        .slug = "grok",
        .name = "Grok",
        .route_name = "Grok subscription",
        .description = "SuperGrok or X Premium subscription",
        .subscription = true,
        .login_source = .grok_subscription,
    },
    .{ .id = .openai, .slug = "openai", .name = "OpenAI", .route_name = "OpenAI", .description = "Enter an API key to connect", .subscription = false, .login_source = .openai_key },
    .{ .id = .anthropic, .slug = "anthropic", .name = "Anthropic", .route_name = "Anthropic", .description = "Enter an API key to connect", .subscription = false, .login_source = .anthropic_key },
    .{ .id = .gemini, .slug = "gemini", .name = "Google Gemini", .route_name = "Google Gemini", .description = "Enter an API key to connect", .subscription = false, .login_source = .gemini_key },
    .{ .id = .xai, .slug = "xai", .name = "xAI", .route_name = "xAI", .description = "Enter an API key to connect", .subscription = false, .login_source = .xai_key },
    .{ .id = .deepseek, .slug = "deepseek", .name = "DeepSeek", .route_name = "DeepSeek", .description = "Enter an API key to connect", .subscription = false, .login_source = .deepseek_key },
    .{ .id = .mistral, .slug = "mistral", .name = "Mistral", .route_name = "Mistral", .description = "Enter an API key to connect", .subscription = false, .login_source = .mistral_key },
    .{ .id = .groq, .slug = "groq", .name = "Groq", .route_name = "Groq", .description = "Enter an API key to connect", .subscription = false, .login_source = .groq_key },
    .{ .id = .together, .slug = "together", .name = "Together AI", .route_name = "Together AI", .description = "Enter an API key to connect", .subscription = false, .login_source = .together_key },
    .{ .id = .fireworks, .slug = "fireworks", .name = "Fireworks AI", .route_name = "Fireworks AI", .description = "Enter an API key to connect", .subscription = false, .login_source = .fireworks_key },
    .{ .id = .openrouter, .slug = "openrouter", .name = "OpenRouter", .route_name = "OpenRouter", .description = "Enter an API key to connect", .subscription = false, .login_source = .openrouter_key },
    .{ .id = .opencode, .slug = "opencode", .name = "OpenCode Local", .route_name = "OpenCode Local", .description = "Start and connect to OpenCode locally", .subscription = false, .login_source = .opencode_local },
    .{ .id = .minimax, .slug = "minimax", .name = "MiniMax Token Plan", .route_name = "MiniMax Token Plan", .description = "Enter an API key to connect", .subscription = true, .login_source = .minimax_key },
    .{ .id = .qwen, .slug = "qwen", .name = "QwenCloud Token Plan", .route_name = "QwenCloud Token Plan", .description = "Enter an API key to connect", .subscription = true, .login_source = .qwen_key },
    .{ .id = .ollama, .slug = "ollama", .name = "Ollama Local", .route_name = "Ollama Local", .description = "Connect to your running Ollama server; no API key required", .subscription = false, .login_source = .ollama_local },
    .{ .id = .ollama_cloud, .slug = "ollama_cloud", .name = "Ollama Cloud", .route_name = "Ollama Cloud", .description = "Enter your Ollama cloud API key", .subscription = true, .login_source = .ollama_cloud_key },
};

pub fn parse(value: []const u8) ?model_provider.ProviderId {
    for (&entries) |*entry| {
        if (std.ascii.eqlIgnoreCase(value, entry.slug)) return entry.id;
        for (entry.aliases) |alias| if (std.ascii.eqlIgnoreCase(value, alias)) return entry.id;
    }
    return null;
}

pub fn find(id: model_provider.ProviderId) *const Entry {
    for (&entries) |*entry| if (entry.id == id) return entry;
    unreachable;
}

pub fn label(id: model_provider.ProviderId) []const u8 {
    return find(id).route_name;
}

test "auth provider catalog uses the model provider identity and explicit aliases" {
    try std.testing.expectEqual(model_provider.ProviderId.codex, parse("codex").?);
    try std.testing.expectEqual(model_provider.ProviderId.grok, parse("grok").?);
    try std.testing.expectEqual(model_provider.ProviderId.opencode, parse("opencode").?);
    try std.testing.expect(parse("openai-codex") == null);
    try std.testing.expect(parse("chatgpt") == null);
    try std.testing.expect(parse("unknown") == null);
    try std.testing.expect(find(.codex).subscription);
    try std.testing.expect(find(.grok).subscription);
}
