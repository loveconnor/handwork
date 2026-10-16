//! Kitty graphics Unicode placeholders.
//!
//! Every image cell in the transcript is the private-use codepoint
//! U+10EEEE followed by two combining diacritics that name the cell's row
//! and column inside the image, with the image id carried in the 24-bit
//! foreground color. Kitty-compatible terminals draw the image directly
//! from these cells. For every other protocol the cells stay in Handwork's
//! cell model (so diffing, scrolling, and reflow track the image like text)
//! and are blanked on the wire before pixels are drawn on top.
//!
//! Reference: https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders

const std = @import("std");

pub const codepoint: u21 = 0x10EEEE;
pub const utf8 = "\u{10EEEE}";

/// Row/column diacritics in protocol order (kitty gen/rowcolumn-diacritics.txt).
pub const diacritics = [_]u21{
    0x0305,  0x030D,  0x030E,  0x0310,  0x0312,  0x033D,  0x033E,  0x033F,  0x0346,  0x034A,  0x034B,  0x034C,
    0x0350,  0x0351,  0x0352,  0x0357,  0x035B,  0x0363,  0x0364,  0x0365,  0x0366,  0x0367,  0x0368,  0x0369,
    0x036A,  0x036B,  0x036C,  0x036D,  0x036E,  0x036F,  0x0483,  0x0484,  0x0485,  0x0486,  0x0487,  0x0592,
    0x0593,  0x0594,  0x0595,  0x0597,  0x0598,  0x0599,  0x059C,  0x059D,  0x059E,  0x059F,  0x05A0,  0x05A1,
    0x05A8,  0x05A9,  0x05AB,  0x05AC,  0x05AF,  0x05C4,  0x0610,  0x0611,  0x0612,  0x0613,  0x0614,  0x0615,
    0x0616,  0x0617,  0x0657,  0x0658,  0x0659,  0x065A,  0x065B,  0x065D,  0x065E,  0x06D6,  0x06D7,  0x06D8,
    0x06D9,  0x06DA,  0x06DB,  0x06DC,  0x06DF,  0x06E0,  0x06E1,  0x06E2,  0x06E4,  0x06E7,  0x06E8,  0x06EB,
    0x06EC,  0x0730,  0x0732,  0x0733,  0x0735,  0x0736,  0x073A,  0x073D,  0x073F,  0x0740,  0x0741,  0x0743,
    0x0745,  0x0747,  0x0749,  0x074A,  0x07EB,  0x07EC,  0x07ED,  0x07EE,  0x07EF,  0x07F0,  0x07F1,  0x07F3,
    0x0816,  0x0817,  0x0818,  0x0819,  0x081B,  0x081C,  0x081D,  0x081E,  0x081F,  0x0820,  0x0821,  0x0822,
    0x0823,  0x0825,  0x0826,  0x0827,  0x0829,  0x082A,  0x082B,  0x082C,  0x082D,  0x0951,  0x0953,  0x0954,
    0x0F82,  0x0F83,  0x0F86,  0x0F87,  0x135D,  0x135E,  0x135F,  0x17DD,  0x193A,  0x1A17,  0x1A75,  0x1A76,
    0x1A77,  0x1A78,  0x1A79,  0x1A7A,  0x1A7B,  0x1A7C,  0x1B6B,  0x1B6D,  0x1B6E,  0x1B6F,  0x1B70,  0x1B71,
    0x1B72,  0x1B73,  0x1CD0,  0x1CD1,  0x1CD2,  0x1CDA,  0x1CDB,  0x1CE0,  0x1DC0,  0x1DC1,  0x1DC3,  0x1DC4,
    0x1DC5,  0x1DC6,  0x1DC7,  0x1DC8,  0x1DC9,  0x1DCB,  0x1DCC,  0x1DD1,  0x1DD2,  0x1DD3,  0x1DD4,  0x1DD5,
    0x1DD6,  0x1DD7,  0x1DD8,  0x1DD9,  0x1DDA,  0x1DDB,  0x1DDC,  0x1DDD,  0x1DDE,  0x1DDF,  0x1DE0,  0x1DE1,
    0x1DE2,  0x1DE3,  0x1DE4,  0x1DE5,  0x1DE6,  0x1DFE,  0x20D0,  0x20D1,  0x20D4,  0x20D5,  0x20D6,  0x20D7,
    0x20DB,  0x20DC,  0x20E1,  0x20E7,  0x20E9,  0x20F0,  0x2CEF,  0x2CF0,  0x2CF1,  0x2DE0,  0x2DE1,  0x2DE2,
    0x2DE3,  0x2DE4,  0x2DE5,  0x2DE6,  0x2DE7,  0x2DE8,  0x2DE9,  0x2DEA,  0x2DEB,  0x2DEC,  0x2DED,  0x2DEE,
    0x2DEF,  0x2DF0,  0x2DF1,  0x2DF2,  0x2DF3,  0x2DF4,  0x2DF5,  0x2DF6,  0x2DF7,  0x2DF8,  0x2DF9,  0x2DFA,
    0x2DFB,  0x2DFC,  0x2DFD,  0x2DFE,  0x2DFF,  0xA66F,  0xA67C,  0xA67D,  0xA6F0,  0xA6F1,  0xA8E0,  0xA8E1,
    0xA8E2,  0xA8E3,  0xA8E4,  0xA8E5,  0xA8E6,  0xA8E7,  0xA8E8,  0xA8E9,  0xA8EA,  0xA8EB,  0xA8EC,  0xA8ED,
    0xA8EE,  0xA8EF,  0xA8F0,  0xA8F1,  0xAAB0,  0xAAB2,  0xAAB3,  0xAAB7,  0xAAB8,  0xAABE,  0xAABF,  0xAAC1,
    0xFE20,  0xFE21,  0xFE22,  0xFE23,  0xFE24,  0xFE25,  0xFE26,  0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187,
    0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
};

/// Largest image extent, in cells, that every placeholder can address.
pub const max_cells: u16 = diacritics.len;

/// Image ids travel in a 24-bit truecolor foreground.
pub const max_image_id: u32 = 0xFF_FFFF;

pub fn isDiacritic(cp: u21) bool {
    return diacriticIndex(cp) != null;
}

pub fn diacriticIndex(cp: u21) ?u16 {
    var low: usize = 0;
    var high: usize = diacritics.len;
    while (low < high) {
        const mid = low + (high - low) / 2;
        if (cp < diacritics[mid]) {
            high = mid;
        } else if (cp > diacritics[mid]) {
            low = mid + 1;
        } else {
            return @intCast(mid);
        }
    }
    return null;
}

pub fn colorForImageId(id: u32) [3]u8 {
    std.debug.assert(id != 0 and id <= max_image_id);
    return .{ @intCast((id >> 16) & 0xff), @intCast((id >> 8) & 0xff), @intCast(id & 0xff) };
}

pub fn imageIdForColor(rgb: [3]u8) u32 {
    return (@as(u32, rgb[0]) << 16) | (@as(u32, rgb[1]) << 8) | rgb[2];
}

/// Writes one transcript row of placeholder cells for image row `row`,
/// covering columns `[0, cols)`. Only the first cell names its row and
/// column; the protocol infers the rest from the cell to the left, which
/// keeps one combining suffix per image row in the cell model.
pub fn writeRow(writer: *std.Io.Writer, image_id: u32, row: u16, cols: u16) !void {
    std.debug.assert(row < max_cells and cols <= max_cells and cols > 0);
    const rgb = colorForImageId(image_id);
    try writer.print("\x1b[38;2;{d};{d};{d}m", .{ rgb[0], rgb[1], rgb[2] });
    var buf: [4]u8 = undefined;
    try writer.writeAll(utf8);
    try writer.writeAll(buf[0..try std.unicode.utf8Encode(diacritics[row], &buf)]);
    try writer.writeAll(buf[0..try std.unicode.utf8Encode(diacritics[0], &buf)]);
    var col: u16 = 1;
    while (col < cols) : (col += 1) try writer.writeAll(utf8);
    try writer.writeAll("\x1b[39m");
}

pub const CellRef = struct {
    image_id: u32,
    row: u16,
    col: u16,
};

/// Explicit position carried by a placeholder's diacritics, if any.
pub const ExplicitPosition = struct {
    row: ?u16 = null,
    col: ?u16 = null,
};

pub fn explicitPosition(suffix: []const u8) ExplicitPosition {
    var view = std.unicode.Utf8View.init(suffix) catch return .{};
    var it = view.iterator();
    var position: ExplicitPosition = .{};
    if (it.nextCodepoint()) |row_cp| position.row = diacriticIndex(row_cp);
    if (position.row == null) return .{};
    if (it.nextCodepoint()) |col_cp| position.col = diacriticIndex(col_cp);
    return position;
}

/// Resolves placeholder cells left to right across one terminal row,
/// applying the protocol's inheritance rules for omitted diacritics.
pub const RowResolver = struct {
    previous: ?CellRef = null,

    /// Feeds the next cell in the row. Non-placeholder cells reset
    /// inheritance. Returns the resolved cell, or null when the cell is not
    /// an addressable placeholder.
    pub fn next(self: *RowResolver, cp: u21, suffix: []const u8, fg_rgb: ?[3]u8) ?CellRef {
        const resolved = self.resolve(cp, suffix, fg_rgb);
        self.previous = resolved;
        return resolved;
    }

    fn resolve(self: *RowResolver, cp: u21, suffix: []const u8, fg_rgb: ?[3]u8) ?CellRef {
        if (cp != codepoint) return null;
        const rgb = fg_rgb orelse return null;
        const id = imageIdForColor(rgb);
        if (id == 0) return null;
        const explicit = explicitPosition(suffix);
        const left = if (self.previous) |p| (if (p.image_id == id) p else null) else null;
        if (explicit.row) |row| {
            if (explicit.col) |col| return .{ .image_id = id, .row = row, .col = col };
            const l = left orelse return .{ .image_id = id, .row = row, .col = 0 };
            if (l.row != row) return .{ .image_id = id, .row = row, .col = 0 };
            return .{ .image_id = id, .row = row, .col = l.col + 1 };
        }
        const l = left orelse return null;
        return .{ .image_id = id, .row = l.row, .col = l.col + 1 };
    }
};

/// Byte length of the placeholder cluster starting at `index`: the base
/// codepoint plus any trailing protocol diacritics. Zero when `text` does
/// not start a placeholder at `index`.
pub fn clusterLenAt(text: []const u8, index: usize) usize {
    if (!std.mem.startsWith(u8, text[index..], utf8)) return 0;
    var end = index + utf8.len;
    while (end < text.len) {
        const len = std.unicode.utf8ByteSequenceLength(text[end]) catch break;
        if (end + len > text.len) break;
        const cp = std.unicode.utf8Decode(text[end .. end + len]) catch break;
        if (!isDiacritic(cp)) break;
        end += len;
    }
    return end - index;
}

/// One blanked cluster: `input[input_start..input_end]` became the single
/// space at `output_offset`.
pub const Replacement = struct {
    output_offset: usize,
    input_start: usize,
    input_end: usize,
};

/// Replaces each placeholder cluster in `bytes` with one space, for
/// terminals that draw images out of band. `replacements` records every
/// substitution so a partial write can be mapped back to the source bytes.
pub fn blankClusters(
    alloc: std.mem.Allocator,
    bytes: []const u8,
    out: *std.ArrayList(u8),
    replacements: *std.ArrayList(Replacement),
) !void {
    var copied_from: usize = 0;
    while (std.mem.findPos(u8, bytes, copied_from, utf8)) |start| {
        const end = start + clusterLenAt(bytes, start);
        try out.appendSlice(alloc, bytes[copied_from..start]);
        try replacements.append(alloc, .{ .output_offset = out.items.len, .input_start = start, .input_end = end });
        try out.append(alloc, ' ');
        copied_from = end;
    }
    try out.appendSlice(alloc, bytes[copied_from..]);
}

/// Maps an accepted output byte count back to the input bytes it fully
/// covers. Bytes between replacements map one-to-one; an unwritten blank
/// maps to the start of its cluster.
pub fn mapAcceptedOffset(replacements: []const Replacement, accepted_output: usize) usize {
    var output_cursor: usize = 0;
    var input_cursor: usize = 0;
    for (replacements) |r| {
        if (accepted_output <= r.output_offset) break;
        output_cursor = r.output_offset + 1;
        input_cursor = r.input_end;
    }
    return input_cursor + (accepted_output - output_cursor);
}

/// Reports every image id drawn by placeholder cells in terminal-wire
/// bytes, tracking the foreground color through SGR sequences. `found`
/// receives each id once, in first-seen order.
pub fn collectWireImageIds(alloc: std.mem.Allocator, bytes: []const u8, found: *std.ArrayList(u32)) !void {
    var fg: ?[3]u8 = null;
    var i: usize = 0;
    while (i < bytes.len) {
        if (bytes[i] == 0x1b and i + 1 < bytes.len and bytes[i + 1] == '[') {
            var end = i + 2;
            while (end < bytes.len and (bytes[end] < 0x40 or bytes[end] > 0x7e)) : (end += 1) {}
            if (end >= bytes.len) return;
            if (bytes[end] == 'm') fg = applySgrForeground(fg, bytes[i + 2 .. end]);
            i = end + 1;
            continue;
        }
        if (std.mem.startsWith(u8, bytes[i..], utf8)) {
            if (fg) |rgb| {
                const id = imageIdForColor(rgb);
                if (id != 0 and std.mem.indexOfScalar(u32, found.items, id) == null) try found.append(alloc, id);
            }
            i += utf8.len;
            continue;
        }
        i += 1;
    }
}

fn applySgrForeground(current: ?[3]u8, params: []const u8) ?[3]u8 {
    if (params.len == 0) return null;
    var fg = current;
    var values: [16]u16 = undefined;
    var count: usize = 0;
    var it = std.mem.splitScalar(u8, params, ';');
    while (it.next()) |field| {
        if (count == values.len) break;
        // Colon sub-parameters and private forms never carry our ids.
        values[count] = std.fmt.parseInt(u16, field, 10) catch 0;
        count += 1;
    }
    var k: usize = 0;
    while (k < count) : (k += 1) {
        switch (values[k]) {
            0, 39 => fg = null,
            30...37, 90...97 => fg = null,
            38 => {
                if (k + 4 < count and values[k + 1] == 2) {
                    fg = .{ @truncate(values[k + 2]), @truncate(values[k + 3]), @truncate(values[k + 4]) };
                    k += 4;
                } else if (k + 2 < count and values[k + 1] == 5) {
                    fg = null;
                    k += 2;
                }
            },
            48 => {
                if (k + 1 < count and values[k + 1] == 2) k += 4 else if (k + 1 < count and values[k + 1] == 5) k += 2;
            },
            else => {},
        }
    }
    return fg;
}

test "collectWireImageIds follows separate and combined SGR forms" {
    const alloc = std.testing.allocator;
    var ids: std.ArrayList(u32) = .empty;
    defer ids.deinit(alloc);
    const wire = "\x1b[0m\x1b[38;2;0;0;7m" ++ utf8 ++ "\u{0305}\u{0305}" ++ utf8 ++
        "\x1b[39m" ++ utf8 ++ // default foreground: not an image cell
        "\x1b[1;48;2;9;9;9;38;2;0;1;0m" ++ utf8 ++
        "\x1b[38;2;0;0;7m" ++ utf8;
    try collectWireImageIds(alloc, wire, &ids);
    try std.testing.expectEqualSlices(u32, &.{ 7, 256 }, ids.items);
}

test "diacritic table is sorted and has the protocol's 297 entries" {
    try std.testing.expectEqual(@as(usize, 297), diacritics.len);
    for (diacritics[1..], 0..) |cp, i| try std.testing.expect(cp > diacritics[i]);
    try std.testing.expectEqual(@as(?u16, 0), diacriticIndex(0x0305));
    try std.testing.expectEqual(@as(?u16, 296), diacriticIndex(0x1D244));
    try std.testing.expectEqual(@as(?u16, null), diacriticIndex(0x0306));
}

test "writeRow emits cells that resolve back to their position" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeRow(&out.writer, 0x010203, 4, 3);
    const bytes = out.written();
    try std.testing.expect(std.mem.startsWith(u8, bytes, "\x1b[38;2;1;2;3m"));
    var index = std.mem.indexOf(u8, bytes, utf8).?;
    var resolver: RowResolver = .{};
    var col: u16 = 0;
    while (col < 3) : (col += 1) {
        const len = clusterLenAt(bytes, index);
        const cell = resolver.next(codepoint, bytes[index + utf8.len .. index + len], .{ 1, 2, 3 }).?;
        try std.testing.expectEqual(CellRef{ .image_id = 0x010203, .row = 4, .col = col }, cell);
        index += len;
    }
    try std.testing.expect(std.mem.startsWith(u8, bytes[index..], "\x1b[39m"));
}

test "RowResolver follows the protocol inheritance rules" {
    var resolver: RowResolver = .{};
    // A bare placeholder with nothing to inherit from is not addressable.
    try std.testing.expectEqual(@as(?CellRef, null), resolver.next(codepoint, "", .{ 0, 0, 5 }));
    // Row-only diacritic starts at column zero.
    try std.testing.expectEqual(CellRef{ .image_id = 5, .row = 1, .col = 0 }, resolver.next(codepoint, "\u{030D}", .{ 0, 0, 5 }).?);
    try std.testing.expectEqual(CellRef{ .image_id = 5, .row = 1, .col = 1 }, resolver.next(codepoint, "", .{ 0, 0, 5 }).?);
    // A different image id breaks inheritance.
    try std.testing.expectEqual(@as(?CellRef, null), resolver.next(codepoint, "", .{ 0, 0, 6 }));
    // Plain text resets it.
    _ = resolver.next('x', "", null);
    try std.testing.expectEqual(@as(?CellRef, null), resolver.next(codepoint, "", .{ 0, 0, 5 }));
}

test "blankClusters replaces each placeholder with one space and maps partial writes" {
    const alloc = std.testing.allocator;
    var source: std.Io.Writer.Allocating = .init(alloc);
    defer source.deinit();
    try source.writer.writeAll("ab");
    try writeRow(&source.writer, 7, 0, 2);
    try source.writer.writeAll("z");
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    var offsets: std.ArrayList(Replacement) = .empty;
    defer offsets.deinit(alloc);
    try blankClusters(alloc, source.written(), &out, &offsets);
    try std.testing.expectEqualStrings("ab\x1b[38;2;0;0;7m  \x1b[39mz", out.items);

    const bytes = source.written();
    // Accepting everything maps to the whole input.
    try std.testing.expectEqual(bytes.len, mapAcceptedOffset(offsets.items, out.items.len));
    // Accepting only the SGR prefix maps one-to-one.
    try std.testing.expectEqual(@as(usize, 5), mapAcceptedOffset(offsets.items, 5));
    // Accepting the first blank covers exactly the first (diacritic) cluster.
    const sgr_end = std.mem.indexOf(u8, bytes, utf8).?;
    const first_len = clusterLenAt(bytes, sgr_end);
    try std.testing.expectEqual(sgr_end + first_len, mapAcceptedOffset(offsets.items, sgr_end + 1));
}
