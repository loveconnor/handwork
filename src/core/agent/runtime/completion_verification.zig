const std = @import("std");
const types = @import("../../shared/types.zig");
const execution_memory = @import("execution_memory.zig");
const execution_memory_helpers = @import("../execution_memory.zig");
const file_mutation = @import("../../tooling/file_mutation_contract.zig");
const hooks = @import("../../hooks/hooks.zig");

const Allocator = std.mem.Allocator;

test {
    _ = @import("completion_verification_tests.zig");
}

/// A projection of execution records, never a second persisted task ledger.
/// A passed check describes only the observed command, not task correctness.
/// Mutation detection covers native write_file/edit_file results only. Shell-only
/// mutations and asynchronous shell.interact checks have unknown verification.
pub const Evidence = struct {
    mutations: usize = 0,
    verification: enum { not_required, unknown, check_passed, check_failed } = .not_required,
    permission_blocked: bool = false,

    pub fn needsContinuation(self: Evidence) bool {
        return self.mutations > 0 and !self.permission_blocked and
            (self.verification == .unknown or self.verification == .check_failed);
    }
};

pub fn inspect(alloc: Allocator, execution: types.ExecutionMemory) !Evidence {
    return inspectWithWorkspace(alloc, execution, null);
}

pub fn inspectWithWorkspace(alloc: Allocator, execution: types.ExecutionMemory, workspace_root: ?[]const u8) !Evidence {
    return inspectDetailed(alloc, execution, workspace_root, null);
}

const UnresolvedCheck = struct { arguments: []const u8, call_id: []const u8 };

fn inspectDetailed(alloc: Allocator, execution: types.ExecutionMemory, workspace_root: ?[]const u8, unresolved: ?*std.ArrayList(UnresolvedCheck)) !Evidence {
    var evidence = Evidence{};
    const CheckState = enum { unknown, passed, failed };
    // Exact arguments are a conservative identity including command and cwd.
    // Different JSON encodings may retain an unresolved obligation, never erase it.
    var checks: std.ArrayList(struct { arguments: []const u8, call_id: []const u8, state: CheckState, step_index: usize }) = .empty;
    defer checks.deinit(alloc);
    for (execution.tool_steps, 0..) |step, step_index| {
        // A check in the same parallel group cannot establish post-edit ordering.
        var changed = false;
        for (step.tool_calls) |call| {
            const result = findResult(step, call.id) orelse continue;
            if (try permissionBlocked(alloc, result)) evidence.permission_blocked = true;
            if (result.provider_native or result.review_feedback) continue;
            if (isShell(call.name) and evidence.mutations == 0) evidence.verification = .unknown;
            if (file_mutation.isToolName(call.name) and result.status == .success and
                !file_mutation.resultIsNoop(call.name, result.output))
            {
                evidence.mutations += 1;
                changed = true;
            }
        }
        if (changed) {
            evidence.verification = .unknown;
            for (checks.items) |*check| {
                if (check.state == .passed) check.state = .unknown;
            }
            continue;
        }
        for (step.tool_calls) |call| {
            const result = findResult(step, call.id) orelse continue;
            if (result.provider_native or result.review_feedback) continue;
            if (!isShell(call.name)) continue;
            var parsed = std.json.parseFromSlice(std.json.Value, alloc, call.arguments_json, .{}) catch |err| switch (err) {
                error.OutOfMemory => return err,
                else => continue,
            };
            defer parsed.deinit();
            const command = shellCommand(parsed.value) orelse continue;
            if (workspace_root) |root| {
                const request = shellRequest(parsed.value) orelse continue;
                if (request.get("cwd")) |cwd| {
                    if (cwd != .string or !std.mem.eql(u8, std.mem.trimEnd(u8, cwd.string, "/"), std.mem.trimEnd(u8, root, "/"))) continue;
                }
            }
            if (!isVerificationCommand(command)) continue;
            const process = result.command_process_presentation orelse continue;
            // A generic tool success, output text, or a running handle is not a check result.
            const passed = switch (process) {
                .exit_code => |code| code == 0 and result.status == .success,
                .signal, .timed_out, .output_capture_failed => false,
            };
            var replaced = false;
            for (checks.items) |*check| {
                if (!std.mem.eql(u8, check.arguments, call.arguments_json)) continue;
                if (check.step_index != step_index or check.state != .failed) {
                    check.state = if (passed) .passed else .failed;
                    check.step_index = step_index;
                    check.call_id = call.id;
                }
                replaced = true;
                break;
            }
            if (!replaced) try checks.append(alloc, .{ .arguments = call.arguments_json, .call_id = call.id, .state = if (passed) .passed else .failed, .step_index = step_index });
        }
    }
    if (checks.items.len > 0) {
        var failed = false;
        var unknown = false;
        for (checks.items) |check| {
            failed = failed or check.state == .failed;
            unknown = unknown or check.state == .unknown;
            if (check.state == .failed) {
                if (unresolved) |items| try items.append(alloc, .{ .arguments = check.arguments, .call_id = check.call_id });
            }
        }
        evidence.verification = if (failed) .check_failed else if (unknown) .unknown else .check_passed;
    }
    return evidence;
}

fn findResult(step: types.ToolExecutionStep, id: []const u8) ?types.PersistedToolResult {
    for (step.tool_results) |result| {
        if (std.mem.eql(u8, result.tool_call_id, id)) return result;
    }
    return null;
}

fn isShell(name: []const u8) bool {
    return std.mem.eql(u8, name, "shell") or std.mem.eql(u8, name, "run_command");
}

fn shellRequest(value: std.json.Value) ?std.json.ObjectMap {
    if (value != .object) return null;
    if (value.object.get("request")) |request| {
        if (request != .object) return null;
        return request.object;
    }
    return value.object;
}

fn shellCommand(value: std.json.Value) ?[]const u8 {
    const request = shellRequest(value) orelse return null;
    if (request.get("action")) |action| {
        if (action != .string or !std.mem.eql(u8, action.string, "run")) return null;
    }
    const command = request.get("command") orelse return null;
    return if (command == .string) command.string else null;
}

/// Deliberately narrow. Unsupported commands remain unknown. This recognizes
/// executed checks; it never selects or synthesizes a command to execute.
pub fn isVerificationCommand(command: []const u8) bool {
    const text = std.mem.trim(u8, command, " \t");
    if (std.mem.indexOfAny(u8, text, ";&|\n\r`$<>\\(){}") != null) return false;
    // Discovery, help, collection and dry runs are not executed verification.
    for ([_][]const u8{ "--help", "--version", "--list", "-list", "--collect", "--co", "--setup-plan", "--fixtures", "--markers", "--if-present", "--dry-run", "--no-run", "--show", "--test-list", "--test-no-exec", "--test-cmd", "--build-file", "--build-runner", "--cwd", "-C", "-h" }) |excluded| {
        var words = std.mem.tokenizeAny(u8, text, " \t");
        while (words.next()) |word| {
            if (std.mem.startsWith(u8, word, excluded)) return false;
        }
    }
    for ([_][]const u8{ "zig build test", "zig test", "cargo test", "go test", "bun test", "node --test", "pytest", "python -m pytest", "python3 -m pytest", "npm test", "npm run test", "pnpm test", "yarn test" }) |prefix| {
        if (!std.mem.startsWith(u8, text, prefix)) continue;
        return text.len == prefix.len or text[prefix.len] == ' ' or text[prefix.len] == '\t';
    }
    return false;
}

fn permissionBlocked(alloc: Allocator, result: types.PersistedToolResult) !bool {
    if (result.status != .failure) return false;
    if (result.permission_feedback.len > 0) return true;
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, result.output, .{}) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => return false,
    };
    defer parsed.deinit();
    if (parsed.value != .object) return false;
    const failure = parsed.value.object.get("error") orelse return false;
    if (failure != .object) return false;
    const kind = failure.object.get("type") orelse return false;
    return kind == .string and (std.mem.eql(u8, kind.string, "tool_permission_denied") or
        std.mem.eql(u8, kind.string, "tool_review_held"));
}

pub const continuation_context =
    "Precompletion verification: execution records show file changes without a current passing recognized check. " ++
    "Use the repository's actual verification instructions and the completed tool results. " ++
    "Do not guess shell commands, repeat completed edits, or retry permission-held actions. " ++
    "Perform only relevant verification if permitted. If verification cannot be established, say verification is unknown and name the blocker. " ++
    "This is the only precompletion continuation; finish with the observed command, result, and remaining limits.";

/// Shares the existing Stop continuation instead of creating another retry loop.
pub fn mergeContinuation(alloc: Allocator, outcome: *hooks.StopOutcome, context: ?[]const u8) !void {
    const extra = context orelse return;
    const replacement = switch (outcome.*) {
        .allow => try alloc.dupe(u8, extra),
        .continue_once => |existing| try std.fmt.allocPrint(alloc, "{s}\n\n{s}", .{ existing, extra }),
    };
    outcome.deinit(alloc);
    outcome.* = .{ .continue_once = replacement };
}

/// JSON is bounded, quoted data for model context, never permission authority.
/// The exact execution records remain the source of truth after recovery.
pub fn renderMessages(alloc: Allocator, messages: []const types.ChatMessage) ![]u8 {
    const execution = try execution_memory.buildExecutionMemory(alloc, messages);
    defer types.freeExecutionMemory(alloc, execution);
    return render(alloc, execution);
}

pub fn render(alloc: Allocator, execution: types.ExecutionMemory) ![]u8 {
    var unresolved: std.ArrayList(UnresolvedCheck) = .empty;
    defer unresolved.deinit(alloc);
    const evidence = try inspectDetailed(alloc, execution, null, &unresolved);
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.print("{{\"version\":1,\"source\":\"tool_execution_records\",\"mutation_scope\":\"native_file_tools_only\",\"mutations\":{d},\"verification\":\"{s}\",\"permission_blocked\":{},\"unresolved_check_count\":{d},\"unresolved_checks\":[", .{
        evidence.mutations, @tagName(evidence.verification), evidence.permission_blocked, unresolved.items.len,
    });
    for (unresolved.items[0..@min(unresolved.items.len, 8)], 0..) |check, index| {
        if (index > 0) try out.writer.writeByte(',');
        try out.writer.writeAll("{\"call_id\":");
        try writeString(&out.writer, check.call_id);
        var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(check.arguments, &digest, .{});
        const identity = std.fmt.bytesToHex(digest, .lower);
        try out.writer.print(",\"invocation_sha256\":\"{s}\"", .{&identity});
        var parsed = try std.json.parseFromSlice(std.json.Value, alloc, check.arguments, .{});
        defer parsed.deinit();
        if (shellCommand(parsed.value)) |command| {
            const redacted = try execution_memory_helpers.redactText(alloc, command);
            defer alloc.free(redacted);
            try out.writer.writeAll(",\"command\":");
            try writeString(&out.writer, redacted);
        }
        if (shellRequest(parsed.value)) |request| {
            if (request.get("cwd")) |cwd| {
                if (cwd == .string) {
                    try out.writer.writeAll(",\"cwd\":");
                    try writeString(&out.writer, cwd.string);
                }
            }
        }
        try out.writer.writeByte('}');
    }
    try out.writer.print("],\"omitted_unresolved_checks\":{d},\"operations\":[", .{unresolved.items.len -| 8});
    var total: usize = 0;
    for (execution.tool_steps) |step| {
        for (step.tool_calls) |call| {
            if (findResult(step, call.id) != null and (file_mutation.isToolName(call.name) or isShell(call.name))) total += 1;
        }
    }
    var count: usize = 0;
    const omitted = total -| 8;
    var skip = omitted;
    for (execution.tool_steps) |step| {
        for (step.tool_calls) |call| {
            const result = findResult(step, call.id) orelse continue;
            if (!file_mutation.isToolName(call.name) and !isShell(call.name)) continue;
            if (skip > 0) {
                skip -= 1;
                continue;
            }
            if (count > 0) try out.writer.writeByte(',');
            count += 1;
            try out.writer.writeAll("{\"call_id\":");
            try writeString(&out.writer, call.id);
            try out.writer.writeAll(",\"tool\":");
            try writeString(&out.writer, call.name);
            try out.writer.print(",\"result\":\"{s}\"", .{@tagName(result.status)});
            if (result.command_process_presentation) |process| {
                switch (process) {
                    .exit_code => |code| try out.writer.print(",\"exit_code\":{d}", .{code}),
                    else => try out.writer.print(",\"process\":\"{s}\"", .{@tagName(process)}),
                }
            }
            if (result.output_handle) |handle| {
                try out.writer.writeAll(",\"result_handle\":");
                try writeString(&out.writer, handle);
            }
            for (execution.files) |file| {
                if (!std.mem.eql(u8, file.tool_call_id, call.id)) continue;
                try out.writer.writeAll(",\"path\":");
                try writeString(&out.writer, file.path);
                break;
            }
            if (isShell(call.name)) {
                var parsed = std.json.parseFromSlice(std.json.Value, alloc, call.arguments_json, .{}) catch |err| switch (err) {
                    error.OutOfMemory => return err,
                    else => {
                        try out.writer.writeByte('}');
                        continue;
                    },
                };
                defer parsed.deinit();
                if (shellCommand(parsed.value)) |command| {
                    if (isVerificationCommand(command)) {
                        const redacted = try execution_memory_helpers.redactText(alloc, command);
                        defer alloc.free(redacted);
                        try out.writer.writeAll(",\"command\":");
                        try writeString(&out.writer, redacted);
                    } else {
                        try out.writer.writeAll(",\"command\":\"unknown, omitted\"");
                    }
                }
                if (shellRequest(parsed.value)) |request| {
                    if (request.get("cwd")) |cwd| {
                        if (cwd == .string) {
                            try out.writer.writeAll(",\"cwd\":");
                            try writeString(&out.writer, cwd.string);
                        }
                    }
                }
            }
            try out.writer.writeByte('}');
        }
    }
    try out.writer.print("],\"omitted_operations\":{d}}}", .{omitted});
    return out.toOwnedSlice();
}

fn writeString(writer: *std.Io.Writer, text: []const u8) !void {
    // A truncated value is explicitly marked and must not be replayed as a command.
    var end = @min(text.len, 256);
    while (end > 0 and !std.unicode.utf8ValidateSlice(text[0..end])) end -= 1;
    if (end == text.len) {
        try std.json.Stringify.value(text, .{}, writer);
    } else {
        try writer.writeAll("{\"prefix\":");
        try std.json.Stringify.value(text[0..end], .{}, writer);
        try writer.print(",\"truncated\":true,\"bytes\":{d}}}", .{text.len});
    }
}

test "completion verification recognizes checks but not arbitrary exit-zero commands" {
    for ([_][]const u8{ "zig build test", "zig build test -Dtest-filter=verification", "node --test runtime/runtime.test.mjs", "python3 -m pytest tests" }) |command| {
        try std.testing.expect(isVerificationCommand(command));
    }
    for ([_][]const u8{ "true", "echo passed", "zig build", "zig build test; true", "zig build test || true", "zig build test --help", "pytest --collect-only", "pytest --co", "go test -list .", "npm test --if-present", "cargo test --no-run", "npm test -- --listTests", "zig build testing", "node --test-list" }) |command| {
        try std.testing.expect(!isVerificationCommand(command));
    }
}

test "completion verification merges with one existing Stop continuation" {
    const alloc = std.testing.allocator;
    var outcome: hooks.StopOutcome = .{ .continue_once = try alloc.dupe(u8, "existing hook") };
    defer outcome.deinit(alloc);
    try mergeContinuation(alloc, &outcome, continuation_context);
    try std.testing.expect(std.mem.startsWith(u8, outcome.continue_once, "existing hook\n\n"));
    try std.testing.expect(std.mem.find(u8, outcome.continue_once, "Do not guess shell commands") != null);
}
