//! GIF decoding (GIF87a/GIF89a). Only the first frame is decoded: inline
//! transcript images are stills, and animation would need a timer-driven
//! redraw that the terminal frame pipeline does not have.

const std = @import("std");
const raster_mod = @import("../raster.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;
const Limits = raster_mod.Limits;

pub const Error = Allocator.Error || error{ InvalidImage, ImageTooLarge, UnsupportedImage };

pub fn isGif(bytes: []const u8) bool {
    return bytes.len >= 6 and (std.mem.eql(u8, bytes[0..6], "GIF87a") or std.mem.eql(u8, bytes[0..6], "GIF89a"));
}

const Cursor = struct {
    bytes: []const u8,
    pos: usize = 0,

    fn byte(self: *Cursor) Error!u8 {
        if (self.pos >= self.bytes.len) return error.InvalidImage;
        defer self.pos += 1;
        return self.bytes[self.pos];
    }

    fn take(self: *Cursor, n: usize) Error![]const u8 {
        if (n > self.bytes.len - self.pos) return error.InvalidImage;
        defer self.pos += n;
        return self.bytes[self.pos .. self.pos + n];
    }

    fn u16le(self: *Cursor) Error!u16 {
        const b = try self.take(2);
        return std.mem.readInt(u16, b[0..2], .little);
    }

    fn skipSubBlocks(self: *Cursor) Error!void {
        while (true) {
            const len = try self.byte();
            if (len == 0) return;
            _ = try self.take(len);
        }
    }
};

pub fn decode(alloc: Allocator, bytes: []const u8, limits: Limits) Error!Raster {
    @setRuntimeSafety(true);
    if (!isGif(bytes)) return error.InvalidImage;
    var c = Cursor{ .bytes = bytes, .pos = 6 };
    const screen_w = try c.u16le();
    const screen_h = try c.u16le();
    const flags = try c.byte();
    _ = try c.byte(); // background color index: modern viewers show transparency instead
    _ = try c.byte(); // pixel aspect ratio
    try limits.check(screen_w, screen_h);

    var global_palette: [256][3]u8 = undefined;
    var global_len: usize = 0;
    if (flags & 0x80 != 0) {
        global_len = @as(usize, 2) << @intCast(flags & 7);
        const table = try c.take(global_len * 3);
        for (0..global_len) |i| global_palette[i] = .{ table[i * 3], table[i * 3 + 1], table[i * 3 + 2] };
    }

    var transparent_index: ?u8 = null;
    while (true) {
        switch (try c.byte()) {
            0x21 => {
                const label = try c.byte();
                if (label == 0xF9) {
                    const len = try c.byte();
                    const block = try c.take(len);
                    if (len >= 4 and block[0] & 1 != 0) transparent_index = block[3];
                    try c.skipSubBlocks();
                } else {
                    try c.skipSubBlocks();
                }
            },
            0x2C => return decodeFrame(alloc, &c, screen_w, screen_h, global_palette[0..global_len], transparent_index),
            0x3B => return error.InvalidImage,
            else => return error.InvalidImage,
        }
    }
}

fn decodeFrame(
    alloc: Allocator,
    c: *Cursor,
    screen_w: u16,
    screen_h: u16,
    global_palette: []const [3]u8,
    transparent_index: ?u8,
) Error!Raster {
    @setRuntimeSafety(true);
    const left = try c.u16le();
    const top = try c.u16le();
    const width = try c.u16le();
    const height = try c.u16le();
    const flags = try c.byte();
    var local_palette: [256][3]u8 = undefined;
    var palette: []const [3]u8 = global_palette;
    if (flags & 0x80 != 0) {
        const len = @as(usize, 2) << @intCast(flags & 7);
        const table = try c.take(len * 3);
        for (0..len) |i| local_palette[i] = .{ table[i * 3], table[i * 3 + 1], table[i * 3 + 2] };
        palette = local_palette[0..len];
    }
    if (palette.len == 0) return error.InvalidImage;
    const interlaced = flags & 0x40 != 0;

    const min_code_size = try c.byte();
    if (min_code_size < 2 or min_code_size > 8) return error.InvalidImage;

    var data: std.ArrayList(u8) = .empty;
    defer data.deinit(alloc);
    while (true) {
        const len = try c.byte();
        if (len == 0) break;
        try data.appendSlice(alloc, try c.take(len));
    }

    const pixel_count = @as(usize, width) * height;
    const indices = try alloc.alloc(u8, pixel_count);
    defer alloc.free(indices);
    // Truncated streams are common in the wild; missing pixels stay index 0
    // (made transparent below only when 0 is the transparent index).
    @memset(indices, 0);
    try lzwDecode(data.items, min_code_size, indices);

    var out = try Raster.init(alloc, screen_w, screen_h);
    errdefer out.deinit(alloc);
    var row: usize = 0;
    while (row < height) : (row += 1) {
        const dest_y = @as(usize, top) + interlacedRow(row, height, interlaced);
        if (dest_y >= screen_h) continue;
        var col: usize = 0;
        while (col < width) : (col += 1) {
            const dest_x = @as(usize, left) + col;
            if (dest_x >= screen_w) continue;
            const index = indices[row * width + col];
            if (transparent_index != null and index == transparent_index.?) continue;
            const rgb = if (index < palette.len) palette[index] else [3]u8{ 0, 0, 0 };
            out.pixel(@intCast(dest_x), @intCast(dest_y)).* = .{ rgb[0], rgb[1], rgb[2], 255 };
        }
    }
    return out;
}

/// Maps the n-th stored row to its display row for interlaced frames
/// (rows 0,8,16.. then 4,12.. then 2,6.. then 1,3..).
fn interlacedRow(stored: usize, height: usize, interlaced: bool) usize {
    if (!interlaced) return stored;
    const passes = [_]struct { start: usize, step: usize }{
        .{ .start = 0, .step = 8 }, .{ .start = 4, .step = 8 }, .{ .start = 2, .step = 4 }, .{ .start = 1, .step = 2 },
    };
    var remaining = stored;
    for (passes) |pass| {
        const rows_in_pass = if (height > pass.start) (height - pass.start + pass.step - 1) / pass.step else 0;
        if (remaining < rows_in_pass) return pass.start + remaining * pass.step;
        remaining -= rows_in_pass;
    }
    return stored;
}

fn lzwDecode(data: []const u8, min_code_size: u8, out: []u8) Error!void {
    @setRuntimeSafety(true);
    const max_codes = 4096;
    var prefix: [max_codes]u16 = undefined;
    var suffix: [max_codes]u8 = undefined;
    var length: [max_codes]u16 = undefined;
    const clear_code: u16 = @as(u16, 1) << @intCast(min_code_size);
    const end_code = clear_code + 1;
    for (0..clear_code) |i| {
        prefix[i] = 0;
        suffix[i] = @intCast(i);
        length[i] = 1;
    }

    var code_size: u4 = @intCast(min_code_size + 1);
    var next_code: u16 = clear_code + 2;
    var previous: ?u16 = null;
    var bit_buffer: u32 = 0;
    var bit_count: u5 = 0;
    var data_pos: usize = 0;
    var out_pos: usize = 0;

    while (out_pos < out.len) {
        while (bit_count < code_size) {
            if (data_pos >= data.len) return;
            bit_buffer |= @as(u32, data[data_pos]) << bit_count;
            data_pos += 1;
            bit_count += 8;
        }
        const code: u16 = @intCast(bit_buffer & ((@as(u32, 1) << code_size) - 1));
        bit_buffer >>= code_size;
        bit_count -= code_size;

        if (code == clear_code) {
            code_size = @intCast(min_code_size + 1);
            next_code = clear_code + 2;
            previous = null;
            continue;
        }
        if (code == end_code) return;

        const prev = previous orelse {
            if (code >= clear_code) return error.InvalidImage;
            out[out_pos] = suffix[code];
            out_pos += 1;
            previous = code;
            continue;
        };

        // Add prev + first(code) (or first(prev) for the KwKwK case where
        // `code` is the entry being defined), then emit `code`'s string.
        const first_byte = if (code < next_code)
            firstByte(&prefix, &length, &suffix, code)
        else if (code == next_code and next_code < max_codes)
            firstByte(&prefix, &length, &suffix, prev)
        else
            return error.InvalidImage;
        if (next_code < max_codes) {
            prefix[next_code] = prev;
            suffix[next_code] = first_byte;
            length[next_code] = length[prev] + 1;
            next_code += 1;
            if (next_code == (@as(u16, 1) << code_size) and code_size < 12) code_size += 1;
        }

        // Write the string backwards from its last byte, clipped to `out`.
        const len = length[code];
        var k = code;
        var write = out_pos + len;
        while (write > out_pos) {
            write -= 1;
            if (write < out.len) out[write] = suffix[k];
            k = prefix[k];
        }
        out_pos = @min(out.len, out_pos + len);
        previous = code;
    }
}

fn firstByte(prefix: *const [4096]u16, length: *const [4096]u16, suffix: *const [4096]u8, code: u16) u8 {
    var k = code;
    var remaining = length[code];
    while (remaining > 1) : (remaining -= 1) k = prefix[k];
    return suffix[k];
}

test "decodes a minimal two-color GIF with transparency" {
    const alloc = std.testing.allocator;
    // 2x2: red, transparent / transparent, red (GCE transparency index 1).
    const gif = "GIF89a\x02\x00\x02\x00\x80\x00\x00" ++
        "\xff\x00\x00\x00\x00\x00" ++
        "\x21\xf9\x04\x01\x00\x00\x01\x00" ++
        "\x2c\x00\x00\x00\x00\x02\x00\x02\x00\x00" ++
        "\x02\x03\x44\x02\x05\x00\x3b";
    var image = try decode(alloc, gif, .default);
    defer image.deinit(alloc);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, image.pixel(0, 0).*);
    try std.testing.expectEqual(@as(u8, 0), image.pixel(1, 0)[3]);
    try std.testing.expectEqual(@as(u8, 0), image.pixel(0, 1)[3]);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, image.pixel(1, 1).*);
}

test "interlaced row order" {
    const order = [_]usize{ 0, 8, 4, 2, 6, 1, 3, 5, 7, 9 };
    for (order, 0..) |expected, stored| try std.testing.expectEqual(expected, interlacedRow(stored, 10, true));
}

test "rejects truncated headers" {
    try std.testing.expectError(error.InvalidImage, decode(std.testing.allocator, "GIF89a\x01", .default));
}
