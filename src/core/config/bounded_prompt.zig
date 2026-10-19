//! Default bounded operating policy. Identity, permissions and communication are shared
//! byte-for-byte with the default prompt; embedded/custom host policy is never rewritten.
const std = @import("std");

const default_prompt = @embedFile("../../builtins/system_prompt.md");
const operation_start = std.mem.indexOf(u8, default_prompt, "# Efficient execution\n") orelse @compileError("default operating policy boundary missing");
const operation_end = std.mem.indexOf(u8, default_prompt, "# Workspace and permissions\n") orelse @compileError("default authority policy boundary missing");
const identity = default_prompt[0..operation_start];
const authority_and_communication = default_prompt[operation_end..];

const shared_operations =
    \\# Bounded execution
    \\
    \\- Read source/test/config with needed status in the FIRST response. Group independent tools, including edits to different files, in the SAME response. Bound read_file files and grep_files patterns. With project context enabled, rely on scoped AGENTS.md; retrieve omitted or newly applicable guidance. Do not repeat covered instruction searches or inspect unrelated directories.
    \\- Use edit_file for localized changes to existing files; batch edits against original text without overlaps. Do not repeat unchanged code or reads. Wait for prerequisites.
    \\- After edits, group required tests, uncovered edge probes and final diff checks in ONE shell.run, chained with &&. Reuse harness/inputs/setup. Probe representative boundary/error classes; expand combinations only for material risk or requirements. Repeat only for changed inputs/dependencies or failure; diagnose first. Never skip required checks or claim unrun results.
    \\- Node ESM inline: --input-type=module with -e or stdin; no --test.
    \\
;

const parent_operations = shared_operations ++
    \\- Keep short work here unless delegation is requested. Assign bounded outcomes, context and nonoverlapping owned paths. Batch independent owned edits while a child runs; integrate and verify once after delivery. No polling or duplicate child work.
    \\- Honor user/AGENTS model/effort choices; use configured IDs. provider requires model; slash never selects provider. Omissions inherit; effort auto uses the model default. Report unavailable choices without substitution. Prefer named steerable children. Routing is creation-only: changes require a new child and concise handoff without conflicting work. Relay steering promptly; queued feedback does not cancel tools and a receipt is not completion. Preserve preferences and unfinished work across interruptions/compaction.
    \\
    \\
;

const child_operations = shared_operations ++
    \\
    \\
;

const parent_prompt = identity ++ parent_operations ++ authority_and_communication;
const child_prompt = identity ++ child_operations ++ authority_and_communication;

pub const Profile = enum { original, parent, child };
pub const Selection = struct {
    content: []const u8,
    profile: Profile,
    saved_bytes: usize,
};

/// Keep explicit legacy overrides compatible; unset now selects bounded execution.
pub fn isEnabled(value: ?[]const u8) bool {
    return if (value) |text| std.mem.eql(u8, text, "1") else true;
}

pub fn select(system_prompt: []const u8, is_child: bool, enabled: bool) Selection {
    if (!enabled or !std.mem.eql(u8, system_prompt, default_prompt)) {
        return .{ .content = system_prompt, .profile = .original, .saved_bytes = 0 };
    }
    const content = if (is_child) child_prompt else parent_prompt;
    return .{ .content = content, .profile = if (is_child) .child else .parent, .saved_bytes = default_prompt.len - content.len };
}

test "bounded prompt preserves authority and custom policy while reducing operating overhead" {
    const testing = std.testing;
    for ([_]bool{ false, true }) |child| {
        const selection = select(default_prompt, child, true);
        try testing.expect(std.mem.startsWith(u8, selection.content, identity));
        try testing.expect(std.mem.endsWith(u8, selection.content, authority_and_communication));
        try testing.expect(selection.saved_bytes > 1500);
        try testing.expectEqual(default_prompt.len - selection.content.len, selection.saved_bytes);
        try testing.expectEqualStrings(default_prompt, select(default_prompt, child, false).content);
        const custom = default_prompt ++ "\nHOST-CUSTOM-POLICY: preserve this exactly";
        const untouched = select(custom, child, true);
        try testing.expectEqualStrings(custom, untouched.content);
        try testing.expectEqual(Profile.original, untouched.profile);
        try testing.expectEqual(@as(usize, 0), untouched.saved_bytes);
    }
    try testing.expect(std.mem.indexOf(u8, parent_prompt, "provider requires model") != null);
    try testing.expect(std.mem.indexOf(u8, parent_prompt, "No polling or duplicate child work") != null);
    for ([_][]const u8{ parent_prompt, child_prompt }) |prompt| {
        try testing.expect(std.mem.indexOf(u8, prompt, "including edits to different files, in the SAME response") != null);
        try testing.expect(std.mem.indexOf(u8, prompt, "Do not repeat covered instruction searches") != null);
        try testing.expect(std.mem.indexOf(u8, prompt, "omitted or newly applicable guidance") != null);
        try testing.expect(std.mem.indexOf(u8, prompt, "Use edit_file for localized changes") != null);
        try testing.expect(std.mem.indexOf(u8, prompt, "final diff checks in ONE shell.run") != null);
        try testing.expect(std.mem.indexOf(u8, prompt, "Never skip required checks or claim unrun results") != null);
    }
    try testing.expect(std.mem.indexOf(u8, child_prompt, "Routing is creation-only") == null);
    std.debug.print("bounded prompt bytes: default={d} parent={d} child={d}\n", .{ default_prompt.len, parent_prompt.len, child_prompt.len });
}

test "bounded prompt defaults on with explicit legacy overrides" {
    const testing = std.testing;
    try testing.expect(isEnabled(null));
    try testing.expect(isEnabled("1"));
    for ([_][]const u8{ "0", "", "false", "invalid" }) |value| {
        try testing.expect(!isEnabled(value));
        try testing.expectEqual(Profile.original, select(default_prompt, false, isEnabled(value)).profile);
        try testing.expectEqual(Profile.original, select(default_prompt, true, isEnabled(value)).profile);
    }
    try testing.expectEqual(Profile.parent, select(default_prompt, false, isEnabled(null)).profile);
    try testing.expectEqual(Profile.child, select(default_prompt, true, isEnabled(null)).profile);
}
