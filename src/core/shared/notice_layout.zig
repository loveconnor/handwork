//! Layout helpers for multi-row slash-command notices.
//!
//! The transcript renderer keeps body lines that start with `├ ` or `└ ` flush
//! with the notice bullet, so a notice body shaped as a summary line followed
//! by tree rows reads as one block:
//!
//! ```text
//! ● Stats: rendering
//! ├ ANSI written      19,062 bytes
//! └ Stream chunks     0
//! ```
const std = @import("std");
const Allocator = std.mem.Allocator;

/// Accumulates a summary line and aligned `label  value` tree rows, then
/// renders them into one notice body.
pub const Tree = struct {
    alloc: Allocator,
    summary: std.ArrayList(u8) = .empty,
    rows: std.ArrayList(Row) = .empty,

    const Row = struct {
        label: []u8,
        value: []u8,
    };

    pub fn init(alloc: Allocator) Tree {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *Tree) void {
        for (self.rows.items) |item| {
            self.alloc.free(item.label);
            self.alloc.free(item.value);
        }
        self.rows.deinit(self.alloc);
        self.summary.deinit(self.alloc);
        self.* = undefined;
    }

    /// Replaces the summary line that precedes the tree rows.
    pub fn setSummary(self: *Tree, comptime fmt: []const u8, args: anytype) !void {
        self.summary.clearRetainingCapacity();
        try self.summary.print(self.alloc, fmt, args);
    }

    /// Appends a `label  value` row. The value is formatted with `fmt`.
    pub fn row(self: *Tree, label: []const u8, comptime fmt: []const u8, args: anytype) !void {
        const value = try std.fmt.allocPrint(self.alloc, fmt, args);
        errdefer self.alloc.free(value);
        try self.rowOwnedValue(label, value);
    }

    /// Appends a `label  value` row with a literal value.
    pub fn rowText(self: *Tree, label: []const u8, value: []const u8) !void {
        const owned = try self.alloc.dupe(u8, value);
        errdefer self.alloc.free(owned);
        try self.rowOwnedValue(label, owned);
    }

    /// Appends a free-form row without a label column.
    pub fn note(self: *Tree, comptime fmt: []const u8, args: anytype) !void {
        try self.row("", fmt, args);
    }

    fn rowOwnedValue(self: *Tree, label: []const u8, value: []u8) !void {
        const owned_label = try self.alloc.dupe(u8, label);
        errdefer self.alloc.free(owned_label);
        try self.rows.append(self.alloc, .{ .label = owned_label, .value = value });
    }

    pub fn rowCount(self: *const Tree) usize {
        return self.rows.items.len;
    }

    /// Renders the summary and rows. The caller owns the returned bytes.
    pub fn render(self: *const Tree) ![]u8 {
        var label_width: usize = 0;
        for (self.rows.items) |item| label_width = @max(label_width, displayLen(item.label));

        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try out.writer.writeAll(self.summary.items);
        for (self.rows.items, 0..) |item, index| {
            if (index > 0 or self.summary.items.len > 0) try out.writer.writeByte('\n');
            try out.writer.writeAll(if (index + 1 == self.rows.items.len) "└ " else "├ ");
            if (item.label.len > 0) {
                try out.writer.writeAll(item.label);
                try out.writer.splatByteAll(' ', label_width - displayLen(item.label) + 2);
            }
            try out.writer.writeAll(item.value);
        }
        return out.toOwnedSlice();
    }
};

/// Labels are ASCII or a few single-width symbols, so code point count is a
/// good enough width estimate for column alignment.
fn displayLen(text: []const u8) usize {
    return std.unicode.utf8CountCodepoints(text) catch text.len;
}

/// Formats an integer with thousands separators: 19062 → "19,062".
pub fn formatThousands(buf: []u8, value: u64) []const u8 {
    var digits: [20]u8 = undefined;
    const raw = std.fmt.bufPrint(&digits, "{d}", .{value}) catch unreachable;
    var len: usize = 0;
    for (raw, 0..) |byte, index| {
        if (index > 0 and (raw.len - index) % 3 == 0) {
            if (len >= buf.len) return buf[0..len];
            buf[len] = ',';
            len += 1;
        }
        if (len >= buf.len) return buf[0..len];
        buf[len] = byte;
        len += 1;
    }
    return buf[0..len];
}

/// Formats a byte count with a binary unit: 19062 → "18.6 KiB".
pub fn formatBytes(buf: []u8, bytes: u64) []const u8 {
    const units = [_][]const u8{ "B", "KiB", "MiB", "GiB", "TiB" };
    var value: f64 = @floatFromInt(bytes);
    var unit: usize = 0;
    while (value >= 1024.0 and unit + 1 < units.len) : (unit += 1) value /= 1024.0;
    if (unit == 0) return std.fmt.bufPrint(buf, "{d} B", .{bytes}) catch "?";
    if (value >= 100.0) return std.fmt.bufPrint(buf, "{d:.0} {s}", .{ value, units[unit] }) catch "?";
    return std.fmt.bufPrint(buf, "{d:.1} {s}", .{ value, units[unit] }) catch "?";
}

/// Formats a duration for humans: 850 → "0.9s", 133_000 → "2m 13s".
pub fn formatDurationMs(buf: []u8, ms: u64) []const u8 {
    if (ms < 60_000) {
        const tenths = (ms + 50) / 100;
        return std.fmt.bufPrint(buf, "{d}.{d}s", .{ tenths / 10, tenths % 10 }) catch "?";
    }
    const total_seconds = ms / 1000;
    if (total_seconds < 3600) {
        return std.fmt.bufPrint(buf, "{d}m {d:0>2}s", .{ total_seconds / 60, total_seconds % 60 }) catch "?";
    }
    const minutes = total_seconds / 60;
    return std.fmt.bufPrint(buf, "{d}h {d:0>2}m", .{ minutes / 60, minutes % 60 }) catch "?";
}

/// Formats a `+added −removed` pair, omitting a zero side when the other is
/// non-zero: (12, 0) → "+12"; (0, 0) → "±0".
pub fn formatChangeCounts(buf: []u8, added: u64, removed: u64) []const u8 {
    var add_buf: [32]u8 = undefined;
    var remove_buf: [32]u8 = undefined;
    if (added == 0 and removed == 0) return "±0";
    if (removed == 0) return std.fmt.bufPrint(buf, "+{s}", .{formatThousands(&add_buf, added)}) catch "?";
    if (added == 0) return std.fmt.bufPrint(buf, "−{s}", .{formatThousands(&remove_buf, removed)}) catch "?";
    return std.fmt.bufPrint(buf, "+{s} −{s}", .{
        formatThousands(&add_buf, added),
        formatThousands(&remove_buf, removed),
    }) catch "?";
}

/// Renders a fixed-width progress bar. `width` counts cells; the filled part
/// is rounded to the nearest cell and clamped to the bar.
pub fn formatBar(buf: []u8, used: u64, total: u64, width: usize) []const u8 {
    const filled_cell = "█";
    const empty_cell = "░";
    const cells = @min(width, buf.len / 3);
    if (cells == 0) return buf[0..0];
    const filled: usize = if (total == 0)
        0
    else
        @intCast(@min(cells, (used * cells + total / 2) / total));
    var len: usize = 0;
    for (0..cells) |index| {
        const cell = if (index < filled) filled_cell else empty_cell;
        @memcpy(buf[len .. len + cell.len], cell);
        len += cell.len;
    }
    return buf[0..len];
}

/// Rounds `used / total` to a whole percentage, clamped to 100 when the usage
/// exceeds the total.
pub fn percentOf(used: u64, total: u64) u64 {
    if (total == 0) return 0;
    return @min(100, (used * 100 + total / 2) / total);
}

test "notice layout tree aligns labels and closes with the last glyph" {
    var tree = Tree.init(std.testing.allocator);
    defer tree.deinit();
    try tree.setSummary("Stats: {s}", .{"rendering"});
    try tree.row("ANSI", "{d}", .{12});
    try tree.rowText("Stream chunks", "0");
    try tree.note("plain note", .{});
    const body = try tree.render();
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings(
        "Stats: rendering\n├ ANSI           12\n├ Stream chunks  0\n└ plain note",
        body,
    );
}

test "notice layout tree without rows renders only the summary" {
    var tree = Tree.init(std.testing.allocator);
    defer tree.deinit();
    try tree.setSummary("Working tree clean", .{});
    const body = try tree.render();
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings("Working tree clean", body);
}

test "notice layout formats numbers, bytes, durations, and change counts" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("0", formatThousands(&buf, 0));
    try std.testing.expectEqualStrings("999", formatThousands(&buf, 999));
    try std.testing.expectEqualStrings("19,062", formatThousands(&buf, 19_062));
    try std.testing.expectEqualStrings("1,000,000", formatThousands(&buf, 1_000_000));
    try std.testing.expectEqualStrings("512 B", formatBytes(&buf, 512));
    try std.testing.expectEqualStrings("18.6 KiB", formatBytes(&buf, 19_062));
    try std.testing.expectEqualStrings("128 KiB", formatBytes(&buf, 128 * 1024));
    try std.testing.expectEqualStrings("2.0 MiB", formatBytes(&buf, 2 * 1024 * 1024));
    try std.testing.expectEqualStrings("0.9s", formatDurationMs(&buf, 850));
    try std.testing.expectEqualStrings("2m 13s", formatDurationMs(&buf, 133_000));
    try std.testing.expectEqualStrings("1h 04m", formatDurationMs(&buf, 3_840_000));
    try std.testing.expectEqualStrings("±0", formatChangeCounts(&buf, 0, 0));
    try std.testing.expectEqualStrings("+12", formatChangeCounts(&buf, 12, 0));
    try std.testing.expectEqualStrings("−3", formatChangeCounts(&buf, 0, 3));
    try std.testing.expectEqualStrings("+1,200 −3", formatChangeCounts(&buf, 1200, 3));
}

test "notice layout bar and percent round and clamp" {
    var buf: [96]u8 = undefined;
    try std.testing.expectEqualStrings("██░░░░░░░░", formatBar(&buf, 21, 100, 10));
    try std.testing.expectEqualStrings("██████████", formatBar(&buf, 250, 100, 10));
    try std.testing.expectEqualStrings("░░░░░░░░░░", formatBar(&buf, 5, 0, 10));
    try std.testing.expectEqual(@as(u64, 21), percentOf(21_400, 100_000));
    try std.testing.expectEqual(@as(u64, 100), percentOf(300, 100));
    try std.testing.expectEqual(@as(u64, 0), percentOf(1, 0));
}
