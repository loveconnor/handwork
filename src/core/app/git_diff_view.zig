//! Turns `git diff` output into per-file transcript diff blocks.
//!
//! The parser is deliberately lenient: it only needs enough structure to show
//! numbered, color-coded lines. Anything it does not recognize is skipped.
const std = @import("std");
const diff_mod = @import("../output/diff.zig");
const text_utils = @import("../shared/text_utils.zig");

const Allocator = std.mem.Allocator;

/// Lines rendered per file before the rest is folded into a summary row.
pub const max_rendered_lines_per_file: usize = 160;
/// Longest diff line kept verbatim; longer lines are cut with a marker.
pub const max_line_bytes: usize = 320;

pub const FileStatus = enum {
    modified,
    added,
    deleted,
    renamed,
    binary,

    pub fn label(self: FileStatus) ?[]const u8 {
        return switch (self) {
            .modified => null,
            .added => "new",
            .deleted => "deleted",
            .renamed => "renamed",
            .binary => "binary",
        };
    }
};

pub const FileChange = struct {
    path: []u8,
    status: FileStatus = .modified,
    additions: u64 = 0,
    deletions: u64 = 0,
    lines: std.ArrayList(diff_mod.PreviewLine) = .empty,
    /// Hunk lines beyond `max_rendered_lines_per_file`, counted but not kept.
    hidden_lines: u64 = 0,

    pub fn deinit(self: *FileChange, alloc: Allocator) void {
        alloc.free(self.path);
        for (self.lines.items) |line| alloc.free(line.text);
        self.lines.deinit(alloc);
        self.* = undefined;
    }

    fn appendLine(self: *FileChange, alloc: Allocator, op: diff_mod.PreviewOp, old_line: ?u32, new_line: ?u32, text: []const u8) !void {
        if (self.lines.items.len >= max_rendered_lines_per_file) {
            if (op != .elision) self.hidden_lines += 1;
            return;
        }
        var safe = try text_utils.encodeTerminalSafe(alloc, text, max_line_bytes);
        errdefer safe.deinit(alloc);
        try self.lines.append(alloc, .{
            .op = op,
            .old_line = old_line,
            .new_line = new_line,
            .text = safe.bytes,
        });
    }
};

pub const Parsed = struct {
    files: []FileChange,

    pub fn deinit(self: *Parsed, alloc: Allocator) void {
        for (self.files) |*file| file.deinit(alloc);
        alloc.free(self.files);
        self.* = undefined;
    }

    pub fn additions(self: Parsed) u64 {
        var total: u64 = 0;
        for (self.files) |file| total += file.additions;
        return total;
    }

    pub fn deletions(self: Parsed) u64 {
        var total: u64 = 0;
        for (self.files) |file| total += file.deletions;
        return total;
    }
};

/// Parses unified diff text as produced by `git diff --no-color`.
pub fn parseUnified(alloc: Allocator, raw: []const u8) !Parsed {
    var files: std.ArrayList(FileChange) = .empty;
    errdefer {
        for (files.items) |*file| file.deinit(alloc);
        files.deinit(alloc);
    }

    var in_hunk = false;
    var hunk_count: usize = 0;
    var old_line: u32 = 0;
    var new_line: u32 = 0;

    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trimEnd(u8, raw_line, "\r");
        if (std.mem.startsWith(u8, line, "diff --git ")) {
            const path = try safePath(alloc, headerPath(line));
            errdefer alloc.free(path);
            try files.append(alloc, .{ .path = path });
            in_hunk = false;
            hunk_count = 0;
            continue;
        }
        if (files.items.len == 0) continue;
        const file = &files.items[files.items.len - 1];

        if (!in_hunk) {
            if (std.mem.startsWith(u8, line, "@@ ")) {
                const range = parseHunkHeader(line) orelse continue;
                old_line = range.old_start;
                new_line = range.new_start;
                if (hunk_count > 0) try file.appendLine(alloc, .elision, null, null, "⋯");
                hunk_count += 1;
                in_hunk = true;
            } else if (std.mem.startsWith(u8, line, "+++ ")) {
                if (stripSidePrefix(line[4..])) |path| try replacePath(alloc, file, path);
            } else if (std.mem.startsWith(u8, line, "--- ")) {
                if (stripSidePrefix(line[4..]) == null and file.status == .modified) file.status = .deleted;
            } else if (std.mem.startsWith(u8, line, "new file mode")) {
                file.status = .added;
            } else if (std.mem.startsWith(u8, line, "deleted file mode")) {
                file.status = .deleted;
            } else if (std.mem.startsWith(u8, line, "rename from") or std.mem.startsWith(u8, line, "rename to")) {
                file.status = .renamed;
            } else if (std.mem.startsWith(u8, line, "Binary files") or std.mem.startsWith(u8, line, "GIT binary patch")) {
                file.status = .binary;
            }
            continue;
        }

        if (line.len == 0) {
            in_hunk = false;
            continue;
        }
        switch (line[0]) {
            ' ' => {
                try file.appendLine(alloc, .context, old_line, new_line, line[1..]);
                old_line +|= 1;
                new_line +|= 1;
            },
            '+' => {
                file.additions += 1;
                try file.appendLine(alloc, .addition, null, new_line, line[1..]);
                new_line +|= 1;
            },
            '-' => {
                file.deletions += 1;
                try file.appendLine(alloc, .deletion, old_line, null, line[1..]);
                old_line +|= 1;
            },
            '\\' => {},
            else => in_hunk = false,
        }
    }

    return .{ .files = try files.toOwnedSlice(alloc) };
}

fn replacePath(alloc: Allocator, file: *FileChange, path: []const u8) !void {
    const owned = try safePath(alloc, path);
    alloc.free(file.path);
    file.path = owned;
}

/// Copies a path with terminal control bytes escaped.
fn safePath(alloc: Allocator, raw: []const u8) ![]u8 {
    const safe = try text_utils.encodeTerminalSafe(alloc, raw, 512);
    return safe.bytes;
}

/// Extracts the `b/` path from `diff --git a/<path> b/<path>`.
fn headerPath(line: []const u8) []const u8 {
    const rest = line["diff --git ".len..];
    if (std.mem.startsWith(u8, rest, "a/")) {
        if (std.mem.indexOf(u8, rest, " b/")) |split| return rest[2..split];
    }
    return rest;
}

/// Returns the path behind an `a/` or `b/` prefix, or null for `/dev/null`.
fn stripSidePrefix(raw: []const u8) ?[]const u8 {
    const trimmed = std.mem.trimEnd(u8, raw, " \t");
    if (std.mem.eql(u8, trimmed, "/dev/null")) return null;
    if (trimmed.len > 2 and (trimmed[0] == 'a' or trimmed[0] == 'b') and trimmed[1] == '/') return trimmed[2..];
    return trimmed;
}

const HunkRange = struct {
    old_start: u32,
    new_start: u32,
};

fn parseHunkHeader(line: []const u8) ?HunkRange {
    // "@@ -12,3 +14,5 @@ optional context"
    var rest = line[3..];
    if (!std.mem.startsWith(u8, rest, "-")) return null;
    rest = rest[1..];
    const old_start = parseLeadingInt(rest) orelse return null;
    const plus = std.mem.indexOfScalar(u8, rest, '+') orelse return null;
    const new_start = parseLeadingInt(rest[plus + 1 ..]) orelse return null;
    return .{ .old_start = old_start, .new_start = new_start };
}

fn parseLeadingInt(text: []const u8) ?u32 {
    var end: usize = 0;
    while (end < text.len and std.ascii.isDigit(text[end])) : (end += 1) {}
    if (end == 0) return null;
    return std.fmt.parseInt(u32, text[0..end], 10) catch null;
}

/// Renders one file as a transcript diff block preview. The caller owns the
/// returned bytes, allocated with `alloc`.
pub fn renderFile(alloc: Allocator, file: FileChange, styles: diff_mod.FormatStyles) ![]u8 {
    var lines: std.ArrayList(diff_mod.PreviewLine) = .empty;
    defer lines.deinit(alloc);
    try lines.appendSlice(alloc, file.lines.items);
    var summary_buffer: [512]u8 = undefined;
    if (file.hidden_lines > 0) {
        const summary = try std.fmt.bufPrint(&summary_buffer, "⋯ {d} more lines not shown · git diff -- {s}", .{
            file.hidden_lines, file.path,
        });
        try lines.append(alloc, .{ .op = .notice, .text = summary });
    }
    return diff_mod.formatFileChangePreview(alloc, .{
        .path = file.path,
        .lines = lines.items,
        .additions = @intCast(@min(file.additions, std.math.maxInt(u32))),
        .deletions = @intCast(@min(file.deletions, std.math.maxInt(u32))),
        .truncated = file.hidden_lines > 0,
    }, styles);
}

/// Renders one file as plain text for hosts without a diff block surface.
pub fn renderFilePlain(alloc: Allocator, file: FileChange) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    for (file.lines.items, 0..) |line, index| {
        if (index > 0) try out.writer.writeByte('\n');
        const sign: u8 = switch (line.op) {
            .addition => '+',
            .deletion => '-',
            .context, .elision, .notice => ' ',
        };
        try out.writer.writeByte(sign);
        try out.writer.writeByte(' ');
        try out.writer.writeAll(line.text);
    }
    if (file.hidden_lines > 0) {
        if (file.lines.items.len > 0) try out.writer.writeByte('\n');
        try out.writer.print("⋯ {d} more lines not shown", .{file.hidden_lines});
    }
    return out.toOwnedSlice();
}

pub const NumstatEntry = struct {
    path: []u8,
    /// Null for binary files, which `--numstat` reports as `-`.
    additions: ?u64,
    deletions: ?u64,
};

pub const Numstat = struct {
    entries: []NumstatEntry,

    pub fn deinit(self: *Numstat, alloc: Allocator) void {
        for (self.entries) |entry| alloc.free(entry.path);
        alloc.free(self.entries);
        self.* = undefined;
    }
};

/// Parses `git diff --numstat` output: `<added>\t<deleted>\t<path>` per line.
pub fn parseNumstat(alloc: Allocator, raw: []const u8) !Numstat {
    var entries: std.ArrayList(NumstatEntry) = .empty;
    errdefer {
        for (entries.items) |entry| alloc.free(entry.path);
        entries.deinit(alloc);
    }
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trimEnd(u8, raw_line, "\r");
        if (line.len == 0) continue;
        var fields = std.mem.splitScalar(u8, line, '\t');
        const added = fields.next() orelse continue;
        const deleted = fields.next() orelse continue;
        const path = fields.rest();
        if (path.len == 0) continue;
        var safe = try text_utils.encodeTerminalSafe(alloc, path, 512);
        errdefer safe.deinit(alloc);
        try entries.append(alloc, .{
            .path = safe.bytes,
            .additions = std.fmt.parseInt(u64, added, 10) catch null,
            .deletions = std.fmt.parseInt(u64, deleted, 10) catch null,
        });
    }
    return .{ .entries = try entries.toOwnedSlice(alloc) };
}

const sample_diff =
    "diff --git a/src/a.zig b/src/a.zig\n" ++
    "index 1111111..2222222 100644\n" ++
    "--- a/src/a.zig\n" ++
    "+++ b/src/a.zig\n" ++
    "@@ -1,3 +1,4 @@\n" ++
    " const std = @import(\"std\");\n" ++
    "-const old = 1;\n" ++
    "+const new = 2;\n" ++
    "+const extra = 3;\n" ++
    " pub fn main() void {}\n" ++
    "@@ -20,2 +21,2 @@ fn tail() void {\n" ++
    "-    --old\n" ++
    "+    ++new\x1b[2J\n" ++
    "\\ No newline at end of file\n" ++
    "diff --git a/docs/new.md b/docs/new.md\n" ++
    "new file mode 100644\n" ++
    "index 0000000..3333333\n" ++
    "--- /dev/null\n" ++
    "+++ b/docs/new.md\n" ++
    "@@ -0,0 +1 @@\n" ++
    "+# hello\n" ++
    "diff --git a/img.png b/img.png\n" ++
    "index 4444444..5555555 100644\n" ++
    "Binary files a/img.png and b/img.png differ\n";

test "git diff view parses files, hunks, statuses, and line numbers" {
    var parsed = try parseUnified(std.testing.allocator, sample_diff);
    defer parsed.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 3), parsed.files.len);

    const first = parsed.files[0];
    try std.testing.expectEqualStrings("src/a.zig", first.path);
    try std.testing.expectEqual(FileStatus.modified, first.status);
    try std.testing.expectEqual(@as(u64, 3), first.additions);
    try std.testing.expectEqual(@as(u64, 2), first.deletions);
    // 5 lines in hunk one, an elision, then 2 lines in hunk two.
    try std.testing.expectEqual(@as(usize, 8), first.lines.items.len);
    try std.testing.expectEqual(diff_mod.PreviewOp.context, first.lines.items[0].op);
    try std.testing.expectEqual(@as(?u32, 1), first.lines.items[0].old_line);
    try std.testing.expectEqual(@as(?u32, 1), first.lines.items[0].new_line);
    try std.testing.expectEqual(diff_mod.PreviewOp.deletion, first.lines.items[1].op);
    try std.testing.expectEqual(@as(?u32, 2), first.lines.items[1].old_line);
    try std.testing.expectEqual(diff_mod.PreviewOp.addition, first.lines.items[2].op);
    try std.testing.expectEqual(@as(?u32, 2), first.lines.items[2].new_line);
    try std.testing.expectEqual(@as(?u32, 3), first.lines.items[3].new_line);
    try std.testing.expectEqual(@as(?u32, 4), first.lines.items[4].new_line);
    try std.testing.expectEqual(diff_mod.PreviewOp.elision, first.lines.items[5].op);
    try std.testing.expectEqualStrings("    --old", first.lines.items[6].text);
    try std.testing.expectEqual(@as(?u32, 20), first.lines.items[6].old_line);
    try std.testing.expect(std.mem.indexOfScalar(u8, first.lines.items[7].text, 0x1b) == null);

    const second = parsed.files[1];
    try std.testing.expectEqualStrings("docs/new.md", second.path);
    try std.testing.expectEqual(FileStatus.added, second.status);
    try std.testing.expectEqual(@as(u64, 1), second.additions);

    const third = parsed.files[2];
    try std.testing.expectEqualStrings("img.png", third.path);
    try std.testing.expectEqual(FileStatus.binary, third.status);
    try std.testing.expectEqual(@as(usize, 0), third.lines.items.len);

    try std.testing.expectEqual(@as(u64, 4), parsed.additions());
    try std.testing.expectEqual(@as(u64, 2), parsed.deletions());
}

test "git diff view folds lines beyond the per-file cap into a summary row" {
    var text: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer text.deinit();
    try text.writer.writeAll("diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1 +1,300 @@\n");
    for (0..300) |index| try text.writer.print("+line {d}\n", .{index});
    var parsed = try parseUnified(std.testing.allocator, text.writer.buffered());
    defer parsed.deinit(std.testing.allocator);
    const file = parsed.files[0];
    try std.testing.expectEqual(@as(u64, 300), file.additions);
    try std.testing.expectEqual(max_rendered_lines_per_file, file.lines.items.len);
    try std.testing.expectEqual(@as(u64, 300 - max_rendered_lines_per_file), file.hidden_lines);

    const rendered = try renderFile(std.testing.allocator, file, .{});
    defer std.testing.allocator.free(rendered);
    try std.testing.expect(std.mem.find(u8, rendered, "140 more lines not shown") != null);
    const plain = try renderFilePlain(std.testing.allocator, file);
    defer std.testing.allocator.free(plain);
    try std.testing.expect(std.mem.startsWith(u8, plain, "+ line 0\n"));
    try std.testing.expect(std.mem.endsWith(u8, plain, "⋯ 140 more lines not shown"));
}

test "git diff view parses numstat including binary markers" {
    var numstat = try parseNumstat(std.testing.allocator, "12\t3\tsrc/a.zig\n-\t-\timg.png\n\n");
    defer numstat.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 2), numstat.entries.len);
    try std.testing.expectEqualStrings("src/a.zig", numstat.entries[0].path);
    try std.testing.expectEqual(@as(?u64, 12), numstat.entries[0].additions);
    try std.testing.expectEqual(@as(?u64, 3), numstat.entries[0].deletions);
    try std.testing.expectEqual(@as(?u64, null), numstat.entries[1].additions);
}
