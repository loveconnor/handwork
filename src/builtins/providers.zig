const api = @import("../provider/api.zig");
const provider_set = @import("../core/provider/provider_set.zig");
pub const native = provider_set.Set{
    .openai = api.bundle(.openai),
    .anthropic = api.bundle(.anthropic),
    .gemini = api.bundle(.gemini),
    .xai = api.bundle(.xai),
    .deepseek = api.bundle(.deepseek),
    .mistral = api.bundle(.mistral),
    .groq = api.bundle(.groq),
    .together = api.bundle(.together),
    .fireworks = api.bundle(.fireworks),
    .openrouter = api.bundle(.openrouter),
    .minimax = api.bundle(.minimax),
    .qwen = .{},
    .ollama = api.bundle(.ollama),
    .ollama_cloud = api.bundle(.ollama_cloud),

    .codex = .{
        .presentation = @import("../core/auth/provider_catalog.zig").find(.codex),
        .auth_strategy = .chatgpt,
        .title_model = @import("../provider/openai_codex_models.zig").title_model,
        .agent_stream = @import("../provider/openai_codex.zig").agent_stream_provider,
        .cli_model_catalog = @import("../provider/openai_codex_models.zig").cli_model_catalog_provider,
        .model_catalog = @import("../provider/openai_codex_models.zig").model_catalog_provider,
        .permission_reviewer = @import("../provider/openai_codex_permission_reviewer.zig").provider,
    },
    .grok = .{},
};
