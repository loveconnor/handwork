const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");
const types = @import("../shared/types.zig");
const text_utils = @import("../shared/text_utils.zig");
const notice_layout = @import("../shared/notice_layout.zig");
const runtime_profile = @import("../hosts/runtime_profile.zig");
const provider_runtime = @import("provider_runtime.zig");
const doctor_runtime = @import("../cli/doctor_runtime.zig");
const provider_catalog = @import("../auth/provider_catalog.zig");
const permissions = @import("../permissions/permissions.zig");
const git_diff_view = @import("git_diff_view.zig");
const builtin_mcp = @import("../../builtins/mcp.zig");

const Tree = notice_layout.Tree;

/// Full diff text accepted before falling back to per-file totals.
const diff_output_limit = 2 * 1024 * 1024;
const numstat_output_limit = 256 * 1024;
const untracked_output_limit = 512 * 1024;
/// Files that get an inline diff block; the summary still lists every file.
const max_diff_files_rendered = 40;

fn notice(app: anytype, topic: []const u8, body: []const u8) !void {
    try tonedNotice(app, topic, .neutral, body);
}

fn tonedNotice(app: anytype, topic: []const u8, tone: types.NoticeTone, body: []const u8) !void {
    try app.writeDomainNotice(.{ .topic = topic, .tone = tone, .body = body }, true);
}

fn safeNotice(app: anytype, topic: []const u8, body: []const u8, limit: usize) !void {
    var safe = try text_utils.encodeTerminalSafe(app.alloc, body, limit);
    defer safe.deinit(app.alloc);
    try notice(app, topic, safe.bytes);
}

fn treeNotice(app: anytype, topic: []const u8, tone: types.NoticeTone, tree: *const Tree) !void {
    const body = try tree.render();
    defer app.alloc.free(body);
    try tonedNotice(app, topic, tone, body);
}

// ---------------------------------------------------------------------------
// /diff
// ---------------------------------------------------------------------------

const DiffSection = union(enum) {
    unavailable: []const u8,
    failed: ?[]u8,
    parsed: git_diff_view.Parsed,
    summary_only: git_diff_view.Numstat,

    fn deinit(self: *DiffSection, alloc: std.mem.Allocator) void {
        switch (self.*) {
            .unavailable => {},
            .failed => |stderr| if (stderr) |bytes| alloc.free(bytes),
            .parsed => |*parsed| parsed.deinit(alloc),
            .summary_only => |*numstat| numstat.deinit(alloc),
        }
        self.* = undefined;
    }

    fn isEmpty(self: DiffSection) bool {
        return switch (self) {
            .parsed => |parsed| parsed.files.len == 0,
            .summary_only => |numstat| numstat.entries.len == 0,
            .unavailable, .failed => false,
        };
    }
};

const Untracked = union(enum) {
    count: u64,
    many,
    unknown,
};

pub fn showDiff(app: anytype) !void {
    if (comptime !runtime_profile.allows(@TypeOf(app.*), .tools)) {
        return notice(app, "diff", "Local Git inspection is unavailable in this host.");
    }
    try app.flushBeforeBlockingExternalWork();

    var unstaged = try collectDiffSection(app, false);
    defer unstaged.deinit(app.alloc);
    switch (unstaged) {
        .unavailable => |name| return diffUnavailable(app, name),
        .failed => |stderr| return diffFailed(app, stderr),
        else => {},
    }
    var staged = try collectDiffSection(app, true);
    defer staged.deinit(app.alloc);
    const untracked = countUntracked(app);

    if (unstaged.isEmpty() and staged.isEmpty()) {
        var tree = Tree.init(app.alloc);
        defer tree.deinit();
        try tree.setSummary("Working tree clean · no staged or unstaged changes to tracked files", .{});
        try appendUntrackedRow(&tree, untracked);
        return treeNotice(app, "diff", .success, &tree);
    }
    try renderDiffSection(app, "unstaged changes", &unstaged, staged.isEmpty(), "No staged changes.", untracked);
    try renderDiffSection(app, "staged changes", &staged, unstaged.isEmpty(), "No unstaged changes.", .unknown);
}

fn diffUnavailable(app: anytype, error_name: []const u8) !void {
    var buffer: [256]u8 = undefined;
    try tonedNotice(app, "diff", .warning, try std.fmt.bufPrint(&buffer, "Git diff unavailable ({s}). Check that git is installed and this workspace is a repository.", .{error_name}));
}

fn diffFailed(app: anytype, stderr: ?[]u8) !void {
    try tonedNotice(app, "diff", .warning, "Git diff failed. Check that this workspace is a Git repository.");
    if (stderr) |bytes| try safeNotice(app, "diff", bytes, 4096);
}

fn collectDiffSection(app: anytype, comptime staged: bool) !DiffSection {
    const argv = diffArgv(app.workspace_root, staged, false);
    const result = std.process.run(app.alloc, io_mod.getIo(), .{
        .argv = &argv,
        .stdout_limit = .limited(diff_output_limit),
        .stderr_limit = .limited(4096),
    }) catch |err| switch (err) {
        error.StreamTooLong => return collectNumstatSection(app, staged),
        else => return .{ .unavailable = @errorName(err) },
    };
    defer app.alloc.free(result.stdout);
    defer app.alloc.free(result.stderr);
    if (!ranSuccessfully(result.term)) {
        return .{ .failed = if (result.stderr.len > 0) try app.alloc.dupe(u8, result.stderr) else null };
    }
    return .{ .parsed = try git_diff_view.parseUnified(app.alloc, result.stdout) };
}

fn collectNumstatSection(app: anytype, comptime staged: bool) !DiffSection {
    const argv = diffArgv(app.workspace_root, staged, true);
    const result = std.process.run(app.alloc, io_mod.getIo(), .{
        .argv = &argv,
        .stdout_limit = .limited(numstat_output_limit),
        .stderr_limit = .limited(4096),
    }) catch |err| return .{ .unavailable = @errorName(err) };
    defer app.alloc.free(result.stdout);
    defer app.alloc.free(result.stderr);
    if (!ranSuccessfully(result.term)) {
        return .{ .failed = if (result.stderr.len > 0) try app.alloc.dupe(u8, result.stderr) else null };
    }
    return .{ .summary_only = try git_diff_view.parseNumstat(app.alloc, result.stdout) };
}

fn ranSuccessfully(term: std.process.Child.Term) bool {
    return switch (term) {
        .exited => |code| code == 0,
        else => false,
    };
}

fn countUntracked(app: anytype) Untracked {
    const argv = [_][]const u8{
        "git",      "--no-optional-locks", "-C",                 app.workspace_root,
        "ls-files", "--others",            "--exclude-standard", "-z",
    };
    const result = std.process.run(app.alloc, io_mod.getIo(), .{
        .argv = &argv,
        .stdout_limit = .limited(untracked_output_limit),
        .stderr_limit = .limited(1024),
    }) catch |err| return if (err == error.StreamTooLong) .many else .unknown;
    defer app.alloc.free(result.stdout);
    defer app.alloc.free(result.stderr);
    if (!ranSuccessfully(result.term)) return .unknown;
    return .{ .count = std.mem.count(u8, result.stdout, "\x00") };
}

fn appendUntrackedRow(tree: *Tree, untracked: Untracked) !void {
    switch (untracked) {
        .count => |count| if (count > 0) {
            try tree.note("{d} untracked {s} not shown", .{ count, if (count == 1) "file is" else "files are" });
        },
        .many => try tree.note("Untracked files are not shown", .{}),
        .unknown => {},
    }
}

fn renderDiffSection(
    app: anytype,
    topic: []const u8,
    section: *const DiffSection,
    other_empty: bool,
    other_note: []const u8,
    untracked: Untracked,
) !void {
    var change_buf: [64]u8 = undefined;
    switch (section.*) {
        .unavailable => |name| {
            var buffer: [256]u8 = undefined;
            try tonedNotice(app, topic, .warning, try std.fmt.bufPrint(&buffer, "Git diff unavailable ({s}).", .{name}));
        },
        .failed => |stderr| {
            try tonedNotice(app, topic, .warning, "Git diff failed.");
            if (stderr) |bytes| try safeNotice(app, topic, bytes, 4096);
        },
        .parsed => |parsed| {
            if (parsed.files.len == 0) return;
            var tree = Tree.init(app.alloc);
            defer tree.deinit();
            try tree.setSummary("{d} {s} · {s}", .{
                parsed.files.len,
                if (parsed.files.len == 1) "file" else "files",
                notice_layout.formatChangeCounts(&change_buf, parsed.additions(), parsed.deletions()),
            });
            for (parsed.files) |file| {
                const counts = if (file.status == .binary)
                    "binary"
                else
                    notice_layout.formatChangeCounts(&change_buf, file.additions, file.deletions);
                if (file.status.label()) |status| {
                    if (file.status != .binary) {
                        try tree.row(counts, "{s} ({s})", .{ file.path, status });
                        continue;
                    }
                }
                try tree.rowText(counts, file.path);
            }
            if (parsed.files.len > max_diff_files_rendered) {
                try tree.note("Inline diffs are shown for the first {d} files", .{max_diff_files_rendered});
            }
            try appendUntrackedRow(&tree, untracked);
            if (other_empty) try tree.note("{s}", .{other_note});
            try treeNotice(app, topic, .information, &tree);

            for (parsed.files[0..@min(parsed.files.len, max_diff_files_rendered)]) |file| {
                if (file.lines.items.len == 0) continue;
                try emitFileDiff(app, file);
            }
        },
        .summary_only => |numstat| {
            if (numstat.entries.len == 0) return;
            var tree = Tree.init(app.alloc);
            defer tree.deinit();
            var additions: u64 = 0;
            var deletions: u64 = 0;
            for (numstat.entries) |entry| {
                additions += entry.additions orelse 0;
                deletions += entry.deletions orelse 0;
            }
            try tree.setSummary("{d} {s} · {s} · diff exceeds 2 MiB, showing totals only", .{
                numstat.entries.len,
                if (numstat.entries.len == 1) "file" else "files",
                notice_layout.formatChangeCounts(&change_buf, additions, deletions),
            });
            for (numstat.entries) |entry| {
                const counts = if (entry.additions == null or entry.deletions == null)
                    "binary"
                else
                    notice_layout.formatChangeCounts(&change_buf, entry.additions.?, entry.deletions.?);
                try tree.rowText(counts, entry.path);
            }
            try appendUntrackedRow(&tree, untracked);
            if (other_empty) try tree.note("{s}", .{other_note});
            try tree.note("Run git diff directly for the full output", .{});
            try treeNotice(app, topic, .information, &tree);
        },
    }
}

fn emitFileDiff(app: anytype, file: git_diff_view.FileChange) !void {
    const App = @TypeOf(app.*);
    var change_buf: [64]u8 = undefined;
    const header = try std.fmt.allocPrint(app.alloc, "{s} · {s}", .{
        file.path,
        notice_layout.formatChangeCounts(&change_buf, file.additions, file.deletions),
    });
    defer app.alloc.free(header);
    try notice(app, "", header);

    if (comptime @hasDecl(App, "registerAndEmitDiffBlock") and @hasDecl(App, "diffFormatStyles")) {
        // The app frees the preview with the C allocator once the block is recorded.
        const preview = try git_diff_view.renderFile(std.heap.c_allocator, file, app.diffFormatStyles());
        try app.registerAndEmitDiffBlock(.{
            .preview = preview,
            .additions = @intCast(@min(file.additions, std.math.maxInt(u32))),
            .deletions = @intCast(@min(file.deletions, std.math.maxInt(u32))),
        });
        return;
    }
    const plain = try git_diff_view.renderFilePlain(app.alloc, file);
    defer app.alloc.free(plain);
    try notice(app, "", plain);
}

fn diffArgv(
    workspace: []const u8,
    comptime staged: bool,
    comptime numstat: bool,
) [diffArgvLen(staged, numstat)][]const u8 {
    // No shell, pager, external diff, or textconv hooks from repository config.
    var argv: [diffArgvLen(staged, numstat)][]const u8 = undefined;
    const base = [_][]const u8{
        "git",  "--no-pager",    "--no-optional-locks", "-C",         workspace,
        "diff", "--no-ext-diff", "--no-textconv",       "--no-color",
    };
    var index: usize = 0;
    for (base) |arg| {
        argv[index] = arg;
        index += 1;
    }
    if (staged) {
        argv[index] = "--cached";
        index += 1;
    }
    if (numstat) {
        argv[index] = "--numstat";
        index += 1;
    }
    argv[index] = "--";
    return argv;
}

fn diffArgvLen(comptime staged: bool, comptime numstat: bool) usize {
    return 10 + @as(usize, @intFromBool(staged)) + @as(usize, @intFromBool(numstat));
}

// ---------------------------------------------------------------------------
// /jobs
// ---------------------------------------------------------------------------

pub fn showJobs(app: anytype) !void {
    if (comptime !@hasField(@TypeOf(app.*), "managed_executions")) {
        return notice(app, "jobs", "Managed commands are unavailable in this host.");
    }
    const items = try app.managed_executions.list(app.alloc);
    defer {
        for (items) |*item| item.deinit(app.alloc);
        app.alloc.free(items);
    }
    if (items.len == 0) return notice(app, "jobs", "No managed commands.");
    for (items) |item| {
        var id = try text_utils.encodeTerminalSafe(app.alloc, item.execution_id, 128);
        defer id.deinit(app.alloc);
        var command = try text_utils.encodeTerminalSafe(app.alloc, item.command, 256);
        defer command.deinit(app.alloc);
        var buffer: [2048]u8 = undefined;
        const body = try std.fmt.bufPrint(&buffer, "{s} | {s} | {s} | {s}", .{
            id.bytes, @tagName(item.state), @tagName(item.backend), command.bytes,
        });
        try notice(app, "jobs", body);
    }
}

// ---------------------------------------------------------------------------
// /doctor
// ---------------------------------------------------------------------------

const CheckCounts = struct {
    ok: usize = 0,
    warn: usize = 0,
    fail: usize = 0,
};

pub fn showDoctor(app: anytype) !void {
    const App = @TypeOf(app.*);
    if (comptime !runtime_profile.allows(App, .native_auth) or
        !@hasDecl(@TypeOf(app.auth), "secretStore"))
    {
        return notice(app, "doctor", "Local diagnostics are unavailable in this host.");
    }
    try app.flushBeforeBlockingExternalWork();
    var inspection = try builtin_mcp.inspectLocalConfig(app.alloc, app.workspace_root);
    defer inspection.deinit(app.alloc);
    var snapshot = try doctor_runtime.collect(app.alloc, app.auth.secretStore(), provider_runtime.model(app), app.agent_step_limit, inspection.profile_diagnostic);
    defer snapshot.deinit(app.alloc);

    var counts: CheckCounts = .{};
    for (snapshot.checks) |check| switch (check.status) {
        .ok => counts.ok += 1,
        .warn => counts.warn += 1,
        .fail => counts.fail += 1,
    };
    const mcp_issue = inspection.inspection_error != null or inspection.snapshot.configuration_issues.len > 0;
    const tone: types.NoticeTone = if (counts.fail > 0) .@"error" else if (counts.warn > 0 or mcp_issue) .warning else .success;

    var overview = Tree.init(app.alloc);
    defer overview.deinit();
    try setDoctorSummary(&overview, counts, mcp_issue);
    var workspace = try text_utils.encodeTerminalSafe(app.alloc, snapshot.workspace_root, std.Io.Dir.max_path_bytes);
    defer workspace.deinit(app.alloc);
    try overview.rowText("Workspace", workspace.bytes);
    var model = try text_utils.encodeTerminalSafe(app.alloc, snapshot.model, 256);
    defer model.deinit(app.alloc);
    try overview.row("Model", "{s} via {s}", .{ model.bytes, provider_catalog.label(snapshot.provider) });
    try overview.row("Auth", "{s}{s}", .{
        snapshot.auth.activeSourceLabel(),
        if (snapshot.auth.active_source == null)
            ""
        else if (snapshot.auth.expired)
            " · expired"
        else if (snapshot.auth.refreshable())
            " · refreshable"
        else
            "",
    });
    try overview.rowText("Permissions", permissions.permissionModeDisplayLabel(snapshot.permission_mode));
    try overview.row("Step limit", "{d} agent steps per turn", .{snapshot.agent_step_limit});
    try treeNotice(app, "doctor", tone, &overview);

    var checks = Tree.init(app.alloc);
    defer checks.deinit();
    const check_total = snapshot.checks.len + @intFromBool(inspection.inspection_error != null) +
        @intFromBool(inspection.snapshot.configuration_issues.len > 0);
    try checks.setSummary("{d} {s}", .{ check_total, if (check_total == 1) "check" else "checks" });
    for (snapshot.checks) |check| {
        var detail = try text_utils.encodeTerminalSafe(app.alloc, check.detail, 4096);
        defer detail.deinit(app.alloc);
        var label_buf: [128]u8 = undefined;
        var name = try text_utils.encodeTerminalSafe(app.alloc, check.name, 96);
        defer name.deinit(app.alloc);
        const label = try std.fmt.bufPrint(&label_buf, "{s} {s}", .{ checkGlyph(check.status), name.bytes });
        try checks.rowText(label, detail.bytes);
    }
    if (inspection.inspection_error) |err| {
        var detail = try text_utils.encodeTerminalSafe(app.alloc, err, 4096);
        defer detail.deinit(app.alloc);
        try checks.rowText("! mcp", detail.bytes);
    }
    if (inspection.snapshot.configuration_issues.len > 0) {
        try checks.rowText("! mcp", "Configuration has an issue; run /mcp list for details.");
    }
    try checks.note("Saved configuration may differ from this session's overrides.", .{});
    try treeNotice(app, "doctor", .neutral, &checks);
}

fn setDoctorSummary(tree: *Tree, counts: CheckCounts, mcp_issue: bool) !void {
    const warnings = counts.warn + @intFromBool(mcp_issue);
    if (counts.fail == 0 and warnings == 0) {
        return tree.setSummary("All {d} {s} passed", .{ counts.ok, if (counts.ok == 1) "check" else "checks" });
    }
    var summary: std.ArrayList(u8) = .empty;
    defer summary.deinit(tree.alloc);
    try summary.print(tree.alloc, "{d} passed", .{counts.ok});
    if (warnings > 0) try summary.print(tree.alloc, " · {d} {s}", .{ warnings, if (warnings == 1) "warning" else "warnings" });
    if (counts.fail > 0) try summary.print(tree.alloc, " · {d} {s}", .{ counts.fail, if (counts.fail == 1) "failure" else "failures" });
    try tree.setSummary("{s}", .{summary.items});
}

fn checkGlyph(status: doctor_runtime.CheckStatus) []const u8 {
    return switch (status) {
        .ok => "✓",
        .warn => "!",
        .fail => "✗",
    };
}

// ---------------------------------------------------------------------------
// /stats
// ---------------------------------------------------------------------------

pub fn showStats(app: anytype) !void {
    const App = @TypeOf(app.*);
    if (comptime @hasField(App, "session") and @hasDecl(@TypeOf(app.session.usage), "reportSnapshot")) {
        try showSessionStats(app);
    }

    var tree = Tree.init(app.alloc);
    defer tree.deinit();
    try tree.setSummary("Rendering pipeline", .{});
    const metrics: types.Metrics = app.metrics;
    var count_buf: [32]u8 = undefined;
    var bytes_buf: [32]u8 = undefined;
    try tree.row("ANSI written", "{s} bytes ({s})", .{
        notice_layout.formatThousands(&count_buf, metrics.ansi_bytes),
        notice_layout.formatBytes(&bytes_buf, metrics.ansi_bytes),
    });
    try tree.rowText("Full redraws", notice_layout.formatThousands(&count_buf, metrics.full_redraws));
    try tree.rowText("Debounced resizes", notice_layout.formatThousands(&count_buf, metrics.debounced_resizes));
    try tree.rowText("Footer updates", notice_layout.formatThousands(&count_buf, metrics.footer_line_updates));
    try tree.rowText("Stream chunks", notice_layout.formatThousands(&count_buf, metrics.stream_chunks));
    try treeNotice(app, "stats", .information, &tree);
}

fn showSessionStats(app: anytype) !void {
    var usage = app.session.usage.reportSnapshot(app.alloc) catch |err| {
        var buffer: [128]u8 = undefined;
        return tonedNotice(app, "stats", .warning, try std.fmt.bufPrint(&buffer, "Session usage is unavailable ({s}).", .{@errorName(err)}));
    };
    defer usage.deinit(app.alloc);

    var tree = Tree.init(app.alloc);
    defer tree.deinit();
    try tree.setSummary("Session", .{});
    var a: [32]u8 = undefined;
    var b: [32]u8 = undefined;
    var c: [32]u8 = undefined;
    if (comptime @hasDecl(@TypeOf(app.session), "historyLen")) {
        try tree.row("History turns", "{d}", .{app.session.historyLen()});
    }
    if (usage.totals) |totals| {
        if (totals.request_count) |requests| {
            try tree.rowText("Requests", notice_layout.formatThousands(&a, requests));
        }
        if (totals.cache_read_tokens > 0 or totals.cache_write_tokens > 0) {
            try tree.row("Input tokens", "{s} ({s} cache read · {s} cache write)", .{
                notice_layout.formatThousands(&a, totals.input_tokens),
                notice_layout.formatThousands(&b, totals.cache_read_tokens),
                notice_layout.formatThousands(&c, totals.cache_write_tokens),
            });
        } else {
            try tree.rowText("Input tokens", notice_layout.formatThousands(&a, totals.input_tokens));
        }
        if (totals.reasoning_tokens) |reasoning| {
            try tree.row("Output tokens", "{s} ({s} reasoning)", .{
                notice_layout.formatThousands(&a, totals.output_tokens),
                notice_layout.formatThousands(&b, reasoning),
            });
        } else {
            try tree.rowText("Output tokens", notice_layout.formatThousands(&a, totals.output_tokens));
        }
        try tree.row("Cost", "${d:.2}{s}", .{
            totals.total_cost,
            if (usage.completeness == .complete) "" else " · incomplete",
        });
    } else {
        try tree.note("No provider usage recorded yet", .{});
    }
    if (usage.session_activity) |activity| {
        try tree.row("API time", "{s}{s}", .{
            notice_layout.formatDurationMs(&a, activity.api_duration_ms),
            if (activity.api_duration_complete) "" else " · incomplete",
        });
        try tree.row("Wall time", "{s}{s}", .{
            notice_layout.formatDurationMs(&a, activity.wall_duration_ms),
            if (activity.wall_duration_complete) "" else " · incomplete",
        });
        try tree.row("Code changes", "{s} lines{s}", .{
            notice_layout.formatChangeCounts(&a, activity.lines_added, activity.lines_removed),
            if (activity.code_complete) "" else " · incomplete",
        });
    }
    try treeNotice(app, "stats", .information, &tree);
}

// ---------------------------------------------------------------------------
// /export
// ---------------------------------------------------------------------------

const HistoryCounts = struct {
    exchanges: usize = 0,
    interrupted: usize = 0,
    summaries: usize = 0,
};

fn countHistory(history: []const types.HistoryTurn) HistoryCounts {
    var counts: HistoryCounts = .{};
    for (history) |turn| switch (turn) {
        .assistant => counts.exchanges += 1,
        .interrupted => counts.interrupted += 1,
        .compacted_summary => counts.summaries += 1,
    };
    return counts;
}

pub fn exportSession(app: anytype, raw_path: []const u8) !void {
    if (comptime !runtime_profile.allows(@TypeOf(app.*), .durable_sessions)) {
        return notice(app, "export", "Conversation export is owned by the embedding SDK in this host.");
    }
    // Borrow history only while turn admission is held. No snapshot copy and no
    // new persistent state; file output is streamed one text segment at a time.
    if (app.stream.active or !app.worker.tryHoldTurnStart()) {
        return tonedNotice(app, "export", .warning, "Wait for the current response to finish before exporting.");
    }
    defer app.worker.releaseTurnStartHold();
    try app.flushBeforeBlockingExternalWork();
    var name_buffer: [96]u8 = undefined;
    const trimmed = std.mem.trim(u8, raw_path, " \t");
    var random: [6]u8 = undefined;
    io_mod.getIo().random(&random);
    const name = if (trimmed.len > 0) trimmed else try std.fmt.bufPrint(&name_buffer, "handwork-export-{d}-{s}.md", .{
        io_mod.milliTimestamp(), std.fmt.bytesToHex(random, .lower),
    });
    const path = try std.fs.path.resolve(app.alloc, &.{ app.workspace_root, name });
    defer app.alloc.free(path);
    var display = try text_utils.encodeTerminalSafe(app.alloc, path, std.Io.Dir.max_path_bytes);
    defer display.deinit(app.alloc);

    const history = app.session.agent.history.items;
    var tree = Tree.init(app.alloc);
    defer tree.deinit();
    const written = writeExport(path, history) catch |err| {
        try tree.setSummary("Not written", .{});
        try tree.rowText("Path", display.bytes);
        try tree.rowText("Reason", if (err == error.PathAlreadyExists)
            "destination already exists; choose a new path"
        else
            "any newly created file may be incomplete");
        try tree.rowText("Error", @errorName(err));
        return treeNotice(app, "export", .warning, &tree);
    };

    const counts = countHistory(history);
    var size_buf: [32]u8 = undefined;
    try tree.setSummary("Saved {s}", .{std.fs.path.basename(display.bytes)});
    try tree.rowText("Path", display.bytes);
    try appendHistoryCountsRow(&tree, counts);
    try tree.rowText("Size", notice_layout.formatBytes(&size_buf, written));
    try tree.note("Retained text only; attachments and tool output are omitted. Review before sharing.", .{});
    try treeNotice(app, "export", .success, &tree);
}

fn appendHistoryCountsRow(tree: *Tree, counts: HistoryCounts) !void {
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(tree.alloc);
    try text.print(tree.alloc, "{d} {s}", .{ counts.exchanges, if (counts.exchanges == 1) "exchange" else "exchanges" });
    if (counts.interrupted > 0) try text.print(tree.alloc, " · {d} interrupted", .{counts.interrupted});
    if (counts.summaries > 0) {
        try text.print(tree.alloc, " · {d} compacted {s}", .{ counts.summaries, if (counts.summaries == 1) "summary" else "summaries" });
    }
    try tree.rowText("Turns", text.items);
}

/// Writes the export and returns the number of bytes written.
fn writeExport(path: []const u8, history: []const types.HistoryTurn) !u64 {
    const file = try std.Io.Dir.createFileAbsolute(io_mod.getIo(), path, .{
        .truncate = false,
        .exclusive = true,
        .permissions = if (builtin.os.tag == .windows) .default_file else std.Io.File.Permissions.fromMode(0o600),
    });
    defer file.close(io_mod.getIo());
    var sink = FileSink{ .file = file };
    try writeHistory(&sink, history);
    try file.sync(io_mod.getIo());
    return sink.bytes_written;
}

const FileSink = struct {
    file: std.Io.File,
    bytes_written: u64 = 0,

    pub fn writeAll(self: *FileSink, text: []const u8) !void {
        try self.file.writeStreamingAll(io_mod.getIo(), text);
        self.bytes_written += text.len;
    }
};

fn writeHistory(writer: anytype, history: []const types.HistoryTurn) !void {
    try writer.writeAll("# handwork conversation\n\nRetained text only. Earlier compacted turns appear as summaries. Attachments and tool output are omitted.\n\n");
    for (history) |turn| switch (turn) {
        .assistant => |entry| {
            try writeExchange(writer, entry.user.text, entry.assistant);
        },
        .interrupted => |entry| {
            try writeExchange(writer, entry.user.text, entry.assistant orelse "");
            try writer.writeAll("[Response interrupted]\n\n");
        },
        .compacted_summary => |entry| {
            try writer.writeAll("## Compacted summary\n\n");
            try writer.writeAll(entry.summary);
            try writer.writeAll("\n\n");
        },
    };
}

fn writeExchange(writer: anytype, user: []const u8, assistant: []const u8) !void {
    try writer.writeAll("## User\n\n");
    try writer.writeAll(user);
    try writer.writeAll("\n\n## Assistant\n\n");
    try writer.writeAll(assistant);
    try writer.writeAll("\n\n");
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test "slash utilities export streams retained text including interrupted turns and summaries" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const history = [_]types.HistoryTurn{
        .{ .assistant = .{ .user = .{ .text = @constCast("hello") }, .assistant = @constCast("world") } },
        .{ .interrupted = .{ .user = .{ .text = @constCast("stopped") } } },
        .{ .compacted_summary = .{ .summary = @constCast("earlier work"), .removed_turn_count = 1, .compaction_count = 1 } },
    };
    try writeHistory(&output.writer, &history);
    const text = output.writer.buffered();
    try std.testing.expect(std.mem.find(u8, text, "## User\n\nhello\n\n## Assistant\n\nworld") != null);
    try std.testing.expect(std.mem.find(u8, text, "[Response interrupted]") != null);
    try std.testing.expect(std.mem.find(u8, text, "## Compacted summary\n\nearlier work") != null);
    try std.testing.expectEqualStrings("hello", history[0].assistant.user.text);

    const counts = countHistory(&history);
    try std.testing.expectEqual(@as(usize, 1), counts.exchanges);
    try std.testing.expectEqual(@as(usize, 1), counts.interrupted);
    try std.testing.expectEqual(@as(usize, 1), counts.summaries);
    var tree = Tree.init(std.testing.allocator);
    defer tree.deinit();
    try appendHistoryCountsRow(&tree, counts);
    const body = try tree.render();
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings("└ Turns  1 exchange · 1 interrupted · 1 compacted summary", body);
}

test "slash utilities diff argv disables repository execution hooks" {
    inline for (.{ false, true }) |staged| {
        const argv = diffArgv("/workspace with spaces", staged, false);
        try std.testing.expectEqualStrings("/workspace with spaces", argv[4]);
        try std.testing.expectEqualStrings("--no-ext-diff", argv[6]);
        try std.testing.expectEqualStrings("--no-textconv", argv[7]);
        try std.testing.expectEqualStrings("--", argv[argv.len - 1]);
        if (staged) try std.testing.expectEqualStrings("--cached", argv[argv.len - 2]);
    }
    const numstat = diffArgv("/workspace", true, true);
    try std.testing.expectEqualStrings("--cached", numstat[numstat.len - 3]);
    try std.testing.expectEqualStrings("--numstat", numstat[numstat.len - 2]);
    try std.testing.expectEqualStrings("--", numstat[numstat.len - 1]);
}

test "slash utilities jobs reports an empty runtime without starting commands" {
    const managed_execution = @import("../execution/managed_execution.zig");
    const App = struct {
        alloc: std.mem.Allocator,
        managed_executions: managed_execution.Runtime,
        notices: usize = 0,

        pub fn writeDomainNotice(self: *@This(), value: types.SemanticNotice, _: bool) !void {
            try std.testing.expectEqualStrings("No managed commands.", value.body);
            self.notices += 1;
        }
    };
    var app = App{ .alloc = std.testing.allocator, .managed_executions = managed_execution.Runtime.init(std.testing.allocator) };
    defer app.managed_executions.deinit();
    try showJobs(&app);
    try std.testing.expectEqual(@as(usize, 1), app.notices);
}

test "slash utilities stats renders render metrics as an aligned tree" {
    const App = struct {
        alloc: std.mem.Allocator,
        metrics: types.Metrics = .{ .ansi_bytes = 19_062, .stream_chunks = 4 },
        body: std.ArrayList(u8) = .empty,
        tone: ?types.NoticeTone = null,

        pub fn writeDomainNotice(self: *@This(), value: types.SemanticNotice, _: bool) !void {
            try std.testing.expectEqualStrings("stats", value.topic);
            self.tone = value.tone;
            try self.body.appendSlice(self.alloc, value.body);
        }
    };
    var app = App{ .alloc = std.testing.allocator };
    defer app.body.deinit(std.testing.allocator);
    try showStats(&app);
    try std.testing.expectEqualStrings(
        "Rendering pipeline\n" ++
            "├ ANSI written       19,062 bytes (18.6 KiB)\n" ++
            "├ Full redraws       0\n" ++
            "├ Debounced resizes  0\n" ++
            "├ Footer updates     0\n" ++
            "└ Stream chunks      4",
        app.body.items,
    );
    try std.testing.expectEqual(types.NoticeTone.information, app.tone.?);
}

test "slash utilities diff sections render a file summary and per-file blocks" {
    const App = struct {
        alloc: std.mem.Allocator,
        notices: std.ArrayList([]u8) = .empty,

        pub fn writeDomainNotice(self: *@This(), value: types.SemanticNotice, _: bool) !void {
            const line = try std.fmt.allocPrint(self.alloc, "[{s}] {s}", .{ value.topic, value.body });
            try self.notices.append(self.alloc, line);
        }
    };
    var app = App{ .alloc = std.testing.allocator };
    defer {
        for (app.notices.items) |line| std.testing.allocator.free(line);
        app.notices.deinit(std.testing.allocator);
    }
    var section: DiffSection = .{ .parsed = try git_diff_view.parseUnified(std.testing.allocator, "diff --git a/src/a.zig b/src/a.zig\n--- a/src/a.zig\n+++ b/src/a.zig\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n" ++
        "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n") };
    defer section.deinit(std.testing.allocator);
    try renderDiffSection(&app, "unstaged changes", &section, true, "No staged changes.", .{ .count = 2 });
    try std.testing.expectEqual(@as(usize, 3), app.notices.items.len);
    try std.testing.expectEqualStrings(
        "[unstaged changes] 2 files · +1 −1\n" ++
            "├ +1 −1   src/a.zig\n" ++
            "├ binary  img.png\n" ++
            "├ 2 untracked files are not shown\n" ++
            "└ No staged changes.",
        app.notices.items[0],
    );
    try std.testing.expectEqualStrings("[] src/a.zig · +1 −1", app.notices.items[1]);
    try std.testing.expectEqualStrings("[] - old\n+ new\n  context", app.notices.items[2]);
}

test "slash utilities export refuses to overwrite existing files" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "");
    defer std.testing.allocator.free(root);
    const path = try std.fs.path.join(std.testing.allocator, &.{ root, "conversation.md" });
    defer std.testing.allocator.free(path);
    const written = try writeExport(path, &.{});
    try std.testing.expect(written > 0);
    try std.testing.expectError(error.PathAlreadyExists, writeExport(path, &.{}));
}
