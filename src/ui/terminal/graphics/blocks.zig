//! Text-only image fallback: each cell shows two vertically stacked pixels
//! with the upper/lower half block characters. Works in any terminal with
//! 256 colors; truecolor terminals get exact colors.

const std = @import("std");
const raster_mod = @import("../../../core/images/raster.zig");

const Raster = raster_mod.Raster;

const upper_half = "\u{2580}";
const lower_half = "\u{2584}";
const alpha_threshold: u8 = 128;

pub const ColorDepth = enum { truecolor, indexed256 };

/// Writes `image` (already sized to `cols` x `rows * 2` pixels) as `rows`
/// lines of `cols` cells. Each line ends with an SGR reset and, except for
/// the last, `\n`. `line_prefix` is written before every line.
pub fn write(writer: *std.Io.Writer, image: Raster, depth: ColorDepth, line_prefix: []const u8) !void {
    const rows = (image.height + 1) / 2;
    var row: u32 = 0;
    while (row < rows) : (row += 1) {
        try writer.writeAll(line_prefix);
        var x: u32 = 0;
        while (x < image.width) : (x += 1) {
            const top = image.pixel(x, row * 2).*;
            const bottom: [4]u8 = if (row * 2 + 1 < image.height) image.pixel(x, row * 2 + 1).* else .{ 0, 0, 0, 0 };
            const top_visible = top[3] >= alpha_threshold;
            const bottom_visible = bottom[3] >= alpha_threshold;
            if (top_visible and bottom_visible) {
                try writeColor(writer, 38, top, depth);
                try writeColor(writer, 48, bottom, depth);
                try writer.writeAll(upper_half);
            } else if (top_visible) {
                try writer.writeAll("\x1b[49m");
                try writeColor(writer, 38, top, depth);
                try writer.writeAll(upper_half);
            } else if (bottom_visible) {
                try writer.writeAll("\x1b[49m");
                try writeColor(writer, 38, bottom, depth);
                try writer.writeAll(lower_half);
            } else {
                try writer.writeAll("\x1b[39;49m ");
            }
        }
        try writer.writeAll("\x1b[0m");
        if (row + 1 < rows) try writer.writeByte('\n');
    }
}

fn writeColor(writer: *std.Io.Writer, target: u8, rgb: [4]u8, depth: ColorDepth) !void {
    switch (depth) {
        .truecolor => try writer.print("\x1b[{d};2;{d};{d};{d}m", .{ target, rgb[0], rgb[1], rgb[2] }),
        .indexed256 => try writer.print("\x1b[{d};5;{d}m", .{ target, xterm256(rgb[0], rgb[1], rgb[2]) }),
    }
}

/// Nearest xterm-256 entry from the 6x6x6 cube or the 24-step gray ramp.
pub fn xterm256(r: u8, g: u8, b: u8) u8 {
    const levels = [_]u8{ 0, 95, 135, 175, 215, 255 };
    const cube = struct {
        fn index(v: u8) u8 {
            if (v < 48) return 0;
            if (v < 115) return 1;
            return @intCast((@as(u16, v) - 35) / 40);
        }
    };
    const ri = cube.index(r);
    const gi = cube.index(g);
    const bi = cube.index(b);
    const cube_color = [3]u8{ levels[ri], levels[gi], levels[bi] };
    const average: u16 = (@as(u16, r) + g + b) / 3;
    const gray_index: u8 = if (average > 238) 23 else @intCast((@max(average, 3) - 3) / 10);
    const gray_level: u8 = @intCast(8 + @as(u16, gray_index) * 10);
    const cube_distance = distance(.{ r, g, b }, cube_color);
    const gray_distance = distance(.{ r, g, b }, .{ gray_level, gray_level, gray_level });
    if (gray_distance < cube_distance) return 232 + gray_index;
    return 16 + 36 * ri + 6 * gi + bi;
}

fn distance(a: [3]u8, b: [3]u8) u32 {
    var total: u32 = 0;
    inline for (0..3) |c| {
        const d = @as(i32, a[c]) - b[c];
        total += @intCast(d * d);
    }
    return total;
}

test "pairs of pixel rows become one line of half blocks" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 2, 3);
    defer image.deinit(alloc);
    image.pixel(0, 0).* = .{ 255, 0, 0, 255 };
    image.pixel(0, 1).* = .{ 0, 255, 0, 255 };
    image.pixel(1, 1).* = .{ 0, 0, 255, 255 };
    image.pixel(0, 2).* = .{ 1, 2, 3, 255 };
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try write(&out.writer, image, .truecolor, "  ");
    try std.testing.expectEqualStrings(
        "  \x1b[38;2;255;0;0m\x1b[48;2;0;255;0m\u{2580}\x1b[49m\x1b[38;2;0;0;255m\u{2584}\x1b[0m\n" ++
            "  \x1b[49m\x1b[38;2;1;2;3m\u{2580}\x1b[39;49m \x1b[0m",
        out.written(),
    );
}

test "xterm256 maps primaries and grays to their nearest entries" {
    try std.testing.expectEqual(@as(u8, 196), xterm256(255, 0, 0));
    try std.testing.expectEqual(@as(u8, 16), xterm256(0, 0, 0));
    try std.testing.expectEqual(@as(u8, 231), xterm256(255, 255, 255));
    try std.testing.expectEqual(@as(u8, 244), xterm256(128, 128, 128));
}
