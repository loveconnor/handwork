const std = @import("std");
const skill_invocation = @import("../../skills/skill_invocation.zig");
const types = @import("../../shared/types.zig");
const tool_result_limits = @import("../../tooling/tool_result_limits.zig");
const session_child_store = @import("../../session/session_child_store.zig");
const command_replay_store = @import("../../session/command_replay_store.zig");
const context_limits = @import("../../config/context_limits.zig");
const workspace_access = @import("../../workspace/workspace_access.zig");
const model_response_recovery = @import("model_response_recovery.zig");
const provider_set = @import("../../provider/provider_set.zig");
const model_tool_schema = @import("../../tooling/model_tool_schema.zig");
const stream_provider = @import("../stream_provider.zig");
const io_mod = @import("../../shared/io.zig");

pub fn experimentEnabled(value: ?[]const u8) bool {
    return if (value) |text| std.mem.eql(u8, text, "1") else false;
}

pub fn taskEvidenceExperimentEnabled() bool {
    return experimentEnabled(io_mod.getenv("HANDWORK_EXPERIMENT_TASK_EVIDENCE"));
}

test "completion experiments require exact opt in" {
    try std.testing.expect(experimentEnabled("1"));
    for ([_]?[]const u8{ null, "", "0", "true", "yes", " 1" }) |value| {
        try std.testing.expect(!experimentEnabled(value));
    }
}

const ReasoningEffort = types.ReasoningEffort;

/// Who owns the prompt driving this run. A root turn's prompt is real user
/// input; a subagent turn's prompt is assistant-authored delegation and can
/// never establish user authorization for the automatic reviewer.
pub const TurnOrigin = enum { root, subagent };

pub const Config = struct {
    pub const default_step_limit_notice = "Agent step limit reached; continue with a follow-up prompt if needed.";

    system_prompt: []const u8,
    model_prompt_overlay: ?[]const u8 = null,
    host_instructions: []const u8 = "",
    skill_catalog: skill_invocation.Catalog = .{ .skills = &.{} },
    skill_bindings: []const skill_invocation.ExplicitBinding = &.{},
    provider_retry_count: usize,
    max_provider_attempts: usize = model_response_recovery.default_max_provider_attempts,
    /// Interactive hosts may request a durable "try later" pause separately
    /// from cancellation. Headless hosts leave this null.
    recovery_pause_flag: ?*std.atomic.Value(bool) = null,
    provider_chat_url: []const u8,
    advertised_tool_names: []const []const u8 = &.{},
    advertised_functions: []const model_tool_schema.FunctionSchema = &.{},
    /// Null follows HANDWORK_ON_DEMAND_TOOLS. Hosts may explicitly opt out.
    on_demand_tools: ?bool = null,
    initial_dynamic_tools: []const stream_provider.DynamicFunctionTool = &.{},
    provider_capabilities: provider_set.Bundle.Capabilities = .{
        .handwork_search = true,
        .vision_fallback = true,
    },
    custom_tool_guidance: []const u8 = "",
    agent_step_limit: usize,
    max_tool_result_bytes: usize = tool_result_limits.default_max_tool_result_bytes,
    step_limit_notice: []const u8 = default_step_limit_notice,
    cancel_flag: *std.atomic.Value(bool),
    review_enabled: bool = false,
    /// Null follows the opt-in environment; explicit values isolate embedded callers and tests.
    verify_completion: ?bool = null,
    task_evidence: ?bool = null,
    fast_mode: bool = false,
    effort: ReasoningEffort = .auto,
    first_call_tool_choice: types.ToolChoice = .auto,
    workspace_root: []const u8 = "",
    access_scope: ?workspace_access.AccessScope = null,
    origin: TurnOrigin = .root,
    /// Root-user evidence inherited by a subagent turn. Unused for root turns.
    root_user_intent_context: []const u8 = "",
    /// Exact ordered root-user authority inherited by a child. The child task
    /// prompt is intentionally excluded.
    root_user_messages: []const []const u8 = &.{},
    root_user_evidence_complete: bool = false,
    /// True only for a real external user prompt appended to a resumed
    /// persistent child. Internal assistant-authored delegations leave this
    /// false.
    current_prompt_is_root_authority: bool = false,
    enforce_response_language: bool = true,
    tool_result_dir: ?[]const u8 = null,
    session_child_capability: ?*session_child_store.SessionChildCapability = null,
    ephemeral_command_replay: ?*command_replay_store.EphemeralStore = null,
    subagent_id: u64 = 0,
    context_limits: context_limits.Values = .{},

    pub fn verifyCompletionEnabled(self: Config) bool {
        return self.verify_completion orelse experimentEnabled(io_mod.getenv("HANDWORK_EXPERIMENT_VERIFY_COMPLETION"));
    }

    pub fn taskEvidenceEnabled(self: Config) bool {
        return self.task_evidence orelse taskEvidenceExperimentEnabled();
    }
};
