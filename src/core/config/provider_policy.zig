//! Integration-path audit, 2026-09-12. This is not a certification of user conduct.
const std = @import("std");
const model = @import("model_provider.zig");
pub fn nativeEnabled(id: model.ProviderId) bool {
    return switch (id) {
        .grok, .qwen => false,
        else => true,
    };
}
pub fn requireNative(id: model.ProviderId) !void {
    if (!nativeEnabled(id)) return error.ProviderIntegrationDisabled;
}
pub fn reason(id: model.ProviderId) []const u8 {
    return switch (id) {
        .codex => "Native Codex subscription access uses a direct integration whose terms authorization has not been verified. The documented alternative is handwork runtime codex.",
        .grok => "Direct Grok subscription access is disabled. Choose xAI with a developer API key.",
        .qwen => "Qwen Token Plan is disabled: its interactive-only terms cannot be enforced across Handwork's automation and backend surfaces yet.",
        else => "",
    };
}
test "provider policy blocks unapproved native subscription paths" {
    for ([_]model.ProviderId{ .grok, .qwen }) |id| {
        try std.testing.expectError(error.ProviderIntegrationDisabled, requireNative(id));
        try std.testing.expect(reason(id).len > 0);
    }
    for ([_]model.ProviderId{ .codex, .openai, .anthropic, .gemini, .xai, .deepseek, .mistral, .groq, .together, .fireworks, .openrouter, .opencode, .minimax, .ollama, .ollama_cloud }) |id| try requireNative(id);
}
