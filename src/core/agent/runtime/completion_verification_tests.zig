const std = @import("std");
const types = @import("../../shared/types.zig");
const memory = @import("execution_memory.zig");
const verification = @import("completion_verification.zig");
const compaction = @import("context_compaction_state.zig");
const agent = @import("agent.zig");
const support = @import("tests/support.zig");
const hooks = @import("../../hooks/hooks.zig");

const edit_calls = [_]types.ToolCall{.{ .id = "edit-1", .name = "write_file", .arguments_json = "{\"path\":\"src/example.zig\",\"content\":\"new content\"}" }};

fn editedMessages() [2]types.ChatMessage {
    return .{
        .{ .role = .assistant, .tool_calls = &edit_calls },
        .{ .role = .tool, .tool_call_id = "edit-1", .tool_name = "write_file", .content = "Wrote src/example.zig", .tool_result_status = .success },
    };
}

test "completion verification skips read-only no-op failed and uncompleted edits" {
    const alloc = std.testing.allocator;
    var messages = editedMessages();
    messages[1].content = "No changes to src/example.zig";
    const execution = try memory.buildExecutionMemory(alloc, &messages);
    defer types.freeExecutionMemory(alloc, execution);
    try std.testing.expect(!(try verification.inspect(alloc, execution)).needsContinuation());
    const reads = [_]types.ToolCall{.{ .id = "read", .name = "read_file", .arguments_json = "{\"path\":\"src/example.zig\"}" }};
    messages[0].tool_calls = &reads;
    messages[1].tool_call_id = "read";
    messages[1].tool_name = "read_file";
    messages[1].content = "contents";
    const read_execution = try memory.buildExecutionMemory(alloc, &messages);
    defer types.freeExecutionMemory(alloc, read_execution);
    try std.testing.expect(!(try verification.inspect(alloc, read_execution)).needsContinuation());
    messages = editedMessages();
    messages[1].tool_result_status = .failure;
    const failed = try memory.buildExecutionMemory(alloc, &messages);
    defer types.freeExecutionMemory(alloc, failed);
    try std.testing.expect(!(try verification.inspect(alloc, failed)).needsContinuation());
    const unfinished = try memory.buildExecutionMemory(alloc, messages[0..1]);
    defer types.freeExecutionMemory(alloc, unfinished);
    try std.testing.expect(!(try verification.inspect(alloc, unfinished)).needsContinuation());
}

test "completion verification needs typed current post-edit check in matching workspace" {
    const alloc = std.testing.allocator;
    const cases = [_]struct {
        arguments: []const u8,
        process: ?types.CommandProcessPresentation,
        status: types.PersistedToolStatus = .success,
        current: bool = false,
    }{
        .{ .arguments = "{\"request\":{\"action\":\"run\",\"command\":\"zig build test\",\"cwd\":\"/workspace\"}}", .process = .{ .exit_code = 0 }, .current = true },
        .{ .arguments = "{\"command\":\"true\"}", .process = .{ .exit_code = 0 } },
        .{ .arguments = "{\"command\":\"zig build test\"}", .process = null },
        .{ .arguments = "{\"command\":\"zig build test\",\"cwd\":\"/elsewhere\"}", .process = .{ .exit_code = 0 } },
        .{ .arguments = "{\"command\":\"zig build test; true\"}", .process = .{ .exit_code = 0 } },
        .{ .arguments = "{\"command\":\"zig build test\"}", .process = .{ .exit_code = 1 }, .status = .failure },
        .{ .arguments = "{\"command\":\"zig build test\"}", .process = .timed_out, .status = .failure },
    };
    for (cases) |case| {
        const shell_calls = [_]types.ToolCall{.{ .id = "check-1", .name = "shell", .arguments_json = case.arguments }};
        const edits = editedMessages();
        const messages = [_]types.ChatMessage{
            edits[0],                                            edits[1],
            .{ .role = .assistant, .tool_calls = &shell_calls }, .{ .role = .tool, .tool_call_id = "check-1", .tool_name = "shell", .content = "arbitrary output: all passed", .tool_result_status = case.status, .tool_result_memory = .{ .command_process_presentation = case.process } },
        };
        const execution = try memory.buildExecutionMemory(alloc, &messages);
        defer types.freeExecutionMemory(alloc, execution);
        const evidence = try verification.inspectWithWorkspace(alloc, execution, "/workspace");
        try std.testing.expectEqual(!case.current, evidence.needsContinuation());
        try std.testing.expectEqual(case.current, evidence.verification == .check_passed);
        // A later edit makes even an observed passing check stale.
        const reordered = [_]types.ChatMessage{ messages[2], messages[3], messages[0], messages[1] };
        const stale = try memory.buildExecutionMemory(alloc, &reordered);
        defer types.freeExecutionMemory(alloc, stale);
        try std.testing.expect((try verification.inspect(alloc, stale)).verification != .check_passed);
        try std.testing.expect((try verification.inspect(alloc, stale)).needsContinuation());
    }
}

test "completion verification permission holds suppress continuation without granting authority" {
    const alloc = std.testing.allocator;
    for ([_][]const u8{ "{\"error\":{\"type\":\"tool_permission_denied\"}}", "{\"error\":{\"type\":\"tool_review_held\"}}" }) |output| {
        const held_calls = [_]types.ToolCall{.{ .id = "held", .name = "shell", .arguments_json = "{\"command\":\"zig build test\"}" }};
        const edits = editedMessages();
        const messages = [_]types.ChatMessage{
            edits[0],                                           edits[1],
            .{ .role = .assistant, .tool_calls = &held_calls }, .{ .role = .tool, .tool_call_id = "held", .tool_name = "shell", .content = output, .tool_result_status = .failure },
        };
        const execution = try memory.buildExecutionMemory(alloc, &messages);
        defer types.freeExecutionMemory(alloc, execution);
        const evidence = try verification.inspect(alloc, execution);
        try std.testing.expect(evidence.permission_blocked);
        try std.testing.expect(!evidence.needsContinuation());
        try std.testing.expect(evidence.verification != .check_passed);
    }
}

test "completion verification failed check needs a matching ordered rerun" {
    const alloc = std.testing.allocator;
    const a_args = "{\"command\":\"pytest tests\",\"cwd\":\"/workspace\"}";
    const b_args = "{\"command\":\"npm test\",\"cwd\":\"/workspace\"}";
    const edits = editedMessages();
    for ([_]bool{ false, true }) |matching| {
        const first = [_]types.ToolCall{.{ .id = "failed-a", .name = "shell", .arguments_json = a_args }};
        const second = [_]types.ToolCall{.{ .id = "passed", .name = "shell", .arguments_json = if (matching) a_args else b_args }};
        const messages = [_]types.ChatMessage{
            edits[0],                                       edits[1],
            .{ .role = .assistant, .tool_calls = &first },  .{ .role = .tool, .tool_call_id = "failed-a", .tool_name = "shell", .content = "failed", .tool_result_status = .failure, .tool_result_memory = .{ .command_process_presentation = .{ .exit_code = 1 } } },
            .{ .role = .assistant, .tool_calls = &second }, .{ .role = .tool, .tool_call_id = "passed", .tool_name = "shell", .content = "passed", .tool_result_status = .success, .tool_result_memory = .{ .command_process_presentation = .{ .exit_code = 0 } } },
        };
        const execution = try memory.buildExecutionMemory(alloc, &messages);
        defer types.freeExecutionMemory(alloc, execution);
        const evidence = try verification.inspect(alloc, execution);
        try std.testing.expectEqual(!matching, evidence.needsContinuation());
        try std.testing.expectEqual(!matching, evidence.verification == .check_failed);
        // An edit does not erase an outstanding failed check obligation.
        const changed = [_]types.ChatMessage{ messages[0], messages[1], messages[2], messages[3], edits[0], edits[1], messages[4], messages[5] };
        const changed_execution = try memory.buildExecutionMemory(alloc, &changed);
        defer types.freeExecutionMemory(alloc, changed_execution);
        const after_edit = try verification.inspect(alloc, changed_execution);
        try std.testing.expectEqual(!matching, after_edit.needsContinuation());
    }
    const parallel = [_]types.ToolCall{
        .{ .id = "parallel-failed", .name = "shell", .arguments_json = a_args },
        .{ .id = "parallel-passed", .name = "shell", .arguments_json = a_args },
    };
    for ([_]bool{ false, true }) |reverse| {
        var calls = parallel;
        if (reverse) std.mem.reverse(types.ToolCall, &calls);
        const messages = [_]types.ChatMessage{
            edits[0],                                                                                                                                                                                                         edits[1],
            .{ .role = .assistant, .tool_calls = &calls },                                                                                                                                                                    .{ .role = .tool, .tool_call_id = "parallel-failed", .tool_name = "shell", .content = "failed", .tool_result_status = .failure, .tool_result_memory = .{ .command_process_presentation = .{ .exit_code = 1 } } },
            .{ .role = .tool, .tool_call_id = "parallel-passed", .tool_name = "shell", .content = "passed", .tool_result_status = .success, .tool_result_memory = .{ .command_process_presentation = .{ .exit_code = 0 } } },
        };
        const execution = try memory.buildExecutionMemory(alloc, &messages);
        defer types.freeExecutionMemory(alloc, execution);
        try std.testing.expect((try verification.inspect(alloc, execution)).verification == .check_failed);
    }
}

test "completion verification handoff omits arbitrary shell commands" {
    const alloc = std.testing.allocator;
    const calls = [_]types.ToolCall{.{ .id = "arbitrary", .name = "shell", .arguments_json = "{\"command\":\"UNCLASSIFIED_CREDENTIAL=must-not-copy some-command\"}" }};
    const messages = [_]types.ChatMessage{
        .{ .role = .assistant, .tool_calls = &calls },
        .{ .role = .tool, .tool_call_id = "arbitrary", .tool_name = "shell", .content = "finished", .tool_result_status = .success },
    };
    const evidence = try verification.renderMessages(alloc, &messages);
    defer alloc.free(evidence);
    try std.testing.expect(std.mem.find(u8, evidence, "must-not-copy") == null);
    try std.testing.expect(std.mem.find(u8, evidence, "unknown, omitted") != null);
}

test "completion verification same parallel group is not ordered post-edit evidence" {
    const alloc = std.testing.allocator;
    const calls = [_]types.ToolCall{ edit_calls[0], .{ .id = "check", .name = "shell", .arguments_json = "{\"command\":\"zig build test\"}" } };
    const messages = [_]types.ChatMessage{
        .{ .role = .assistant, .tool_calls = &calls },
        editedMessages()[1],
        .{ .role = .tool, .tool_call_id = "check", .tool_name = "shell", .content = "passed", .tool_result_status = .success, .tool_result_memory = .{ .command_process_presentation = .{ .exit_code = 0 } } },
    };
    const execution = try memory.buildExecutionMemory(alloc, &messages);
    defer types.freeExecutionMemory(alloc, execution);
    try std.testing.expect((try verification.inspect(alloc, execution)).needsContinuation());
}

test "completion verification handoff prioritizes old unresolved checks with explicit truncation" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const alloc = arena_state.allocator();
    var messages: std.ArrayList(types.ChatMessage) = .empty;
    const edits = editedMessages();
    try messages.appendSlice(alloc, &edits);
    for (0..20) |index| {
        const failed = index < 10;
        const id = try std.fmt.allocPrint(alloc, "check-{d}", .{index});
        const arguments = if (failed)
            try std.fmt.allocPrint(alloc, "{{\"command\":\"pytest tests/fail_{d}.py\",\"cwd\":\"/workspace\"}}", .{index})
        else
            "{\"command\":\"npm test\",\"cwd\":\"/workspace\"}";
        const calls = try alloc.alloc(types.ToolCall, 1);
        calls[0] = .{ .id = id, .name = "shell", .arguments_json = arguments };
        try messages.append(alloc, .{ .role = .assistant, .tool_calls = calls });
        try messages.append(alloc, .{
            .role = .tool,
            .tool_call_id = id,
            .tool_name = "shell",
            .content = if (failed) "failed" else "passed",
            .tool_result_status = if (failed) .failure else .success,
            .tool_result_memory = .{ .command_process_presentation = .{ .exit_code = if (failed) 1 else 0 } },
        });
    }
    const execution = try memory.buildExecutionMemory(alloc, messages.items);
    const evidence = try verification.render(alloc, execution);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, evidence, .{});
    defer parsed.deinit();
    const object = parsed.value.object;
    try std.testing.expectEqualStrings("check_failed", object.get("verification").?.string);
    try std.testing.expectEqual(@as(i64, 10), object.get("unresolved_check_count").?.integer);
    try std.testing.expectEqual(@as(i64, 2), object.get("omitted_unresolved_checks").?.integer);
    const unresolved = object.get("unresolved_checks").?.array.items;
    try std.testing.expectEqual(@as(usize, 8), unresolved.len);
    try std.testing.expectEqualStrings("check-0", unresolved[0].object.get("call_id").?.string);
    try std.testing.expectEqualStrings("pytest tests/fail_0.py", unresolved[0].object.get("command").?.string);
    try std.testing.expectEqual(@as(usize, 64), unresolved[0].object.get("invocation_sha256").?.string.len);
    try std.testing.expectEqual(@as(usize, 8), object.get("operations").?.array.items.len);
    try std.testing.expect(object.get("omitted_operations").?.integer > 0);
    try std.testing.expect((try verification.inspect(alloc, execution)).needsContinuation());
    // The compact view does not remove or rewrite the durable source records.
    try std.testing.expectEqual(@as(usize, 21), execution.tool_steps.len);
    try std.testing.expectEqualStrings("check-0", execution.tool_steps[1].tool_calls[0].id);
}

test "completion verification structured handoff survives checkpoint without parallel task state" {
    const alloc = std.testing.allocator;
    const messages = editedMessages();
    const evidence = try verification.renderMessages(alloc, &messages);
    defer alloc.free(evidence);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, evidence, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("unknown", parsed.value.object.get("verification").?.string);
    try std.testing.expect(std.mem.find(u8, evidence, "src/example.zig") != null);
    try std.testing.expect(std.mem.find(u8, evidence, "edit-1") != null);
    const handoff = try compaction.renderHandoffWithEvidence(alloc, &.{"Real changes are recorded below."}, evidence);
    defer alloc.free(handoff);
    var original = agent.Agent{};
    defer original.deinit(alloc);
    try original.appendHistoryEntry(alloc, .{ .compacted_summary = .{
        .summary = handoff,
        .removed_turn_count = 1,
        .compaction_count = 1,
    } });
    const checkpoint = try original.checkpoint(alloc);
    defer alloc.free(checkpoint);
    var restored = agent.Agent{};
    defer restored.deinit(alloc);
    try restored.restoreCheckpoint(alloc, checkpoint);
    try std.testing.expectEqualStrings(handoff, restored.history.items[0].compacted_summary.summary);
    try std.testing.expect(std.mem.find(u8, restored.history.items[0].compacted_summary.summary, evidence) != null);
}

test "completion verification opt in adds at most one continuation and preserves defaults" {
    const alloc = std.testing.allocator;
    for ([_]bool{ false, true }) |enabled| {
        const calls = [_]types.ToolCall{.{ .id = "write", .name = "write_file", .arguments_json = "{\"path\":\"handwork-verification-fixture.txt\",\"content\":\"fixture\"}" }};
        var provider = support.FakeProvider.init(alloc, &.{
            .{ .tool_calls = &calls },
            .{ .content = "candidate" },
            .{ .content = "Verification remains unknown." },
        });
        defer provider.deinit();
        var deps = support.FakeAgentRuntimeDeps.init(alloc);
        defer deps.deinit();
        deps.enable_route_recovery = false;
        var fixture = support.PromptFixture{ .workspace_root = "/tmp" };
        var config = fixture.config();
        config.verify_completion = enabled;
        config.task_evidence = false;
        try support.runFakePrompt(&provider, &deps, config, fixture.job());
        try std.testing.expectEqual(@as(usize, if (enabled) 3 else 2), provider.request_bodies.items.len);
        try std.testing.expectEqual(@as(usize, 1), deps.finish_event_count);
        if (enabled) {
            try support.expectBodyContains(&provider, 2, "Precompletion verification:");
            try support.expectBodyContains(&provider, 2, "Do not guess shell commands");
        }
    }
}

test "completion verification shares the existing Stop continuation" {
    const alloc = std.testing.allocator;
    const calls = [_]types.ToolCall{.{ .id = "write", .name = "write_file", .arguments_json = "{\"path\":\"handwork-verification-fixture.txt\",\"content\":\"fixture\"}" }};
    var provider = support.FakeProvider.init(alloc, &.{
        .{ .tool_calls = &calls }, .{ .content = "candidate" }, .{ .content = "final" },
    });
    defer provider.deinit();
    var deps = support.FakeAgentRuntimeDeps.init(alloc);
    defer deps.deinit();
    deps.enable_route_recovery = false;
    var fixture = support.PromptFixture{ .workspace_root = "/tmp" };
    var config = fixture.config();
    config.verify_completion = true;
    config.task_evidence = false;
    var runtime = hooks.Runtime.init(alloc);
    defer runtime.deinit();
    var handler = support.StopTestHandler{ .alloc = alloc, .action = .{ .continue_once = "existing verification request" } };
    defer handler.deinit();
    const view = try support.registerStopTestHandler(&runtime, &handler);
    try support.runFakePromptWithLifecycle(&provider, &deps, config, fixture.job(), support.testLifecycleContext(view, alloc, fixture.workspace_root));
    try std.testing.expectEqual(@as(usize, 1), handler.calls);
    try std.testing.expectEqual(@as(usize, 3), provider.request_bodies.items.len);
    try support.expectBodyContains(&provider, 2, "existing verification request");
    try support.expectBodyContains(&provider, 2, "Precompletion verification:");
}

test "completion verification read-only prompt does not add a model call" {
    const alloc = std.testing.allocator;
    var provider = support.FakeProvider.init(alloc, &.{.{ .content = "Read-only answer" }});
    defer provider.deinit();
    var deps = support.FakeAgentRuntimeDeps.init(alloc);
    defer deps.deinit();
    var fixture = support.PromptFixture{};
    var config = fixture.config();
    config.verify_completion = true;
    config.task_evidence = false;
    try support.runFakePrompt(&provider, &deps, config, fixture.job());
    try std.testing.expectEqual(@as(usize, 1), provider.request_bodies.items.len);
}
