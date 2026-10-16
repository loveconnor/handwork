//! WebP decoding: the RIFF container (simple, VP8X extended with an ALPH
//! alpha chunk, and animations, of which the first frame is shown), WebP
//! lossless (VP8L, RFC 9649) and lossy (VP8 key frames, RFC 6386, in
//! vp8.zig).

const std = @import("std");
const raster_mod = @import("../raster.zig");
const vp8 = @import("vp8.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;
const Limits = raster_mod.Limits;

pub const Error = Allocator.Error || error{ InvalidImage, ImageTooLarge, UnsupportedImage };

pub fn isWebp(bytes: []const u8) bool {
    return bytes.len >= 12 and std.mem.eql(u8, bytes[0..4], "RIFF") and std.mem.eql(u8, bytes[8..12], "WEBP");
}

const Chunk = struct {
    fourcc: []const u8,
    data: []const u8,
};

fn chunks(bytes: []const u8, start: usize, end: usize, out: *std.ArrayList(Chunk), alloc: Allocator) Error!void {
    var pos = start;
    while (pos + 8 <= end) {
        const size = std.mem.readInt(u32, bytes[pos + 4 ..][0..4], .little);
        if (size > end - pos - 8) return error.InvalidImage;
        try out.append(alloc, .{ .fourcc = bytes[pos .. pos + 4], .data = bytes[pos + 8 .. pos + 8 + size] });
        pos += 8 + size + (size & 1);
    }
}

pub fn decode(alloc: Allocator, bytes: []const u8, limits: Limits) Error!Raster {
    @setRuntimeSafety(true);
    if (!isWebp(bytes)) return error.InvalidImage;
    const riff_size = std.mem.readInt(u32, bytes[4..8], .little);
    const end = @min(bytes.len, @as(usize, riff_size) + 8);
    var list: std.ArrayList(Chunk) = .empty;
    defer list.deinit(alloc);
    try chunks(bytes, 12, end, &list, alloc);
    if (list.items.len == 0) return error.InvalidImage;

    var alpha: ?[]const u8 = null;
    for (list.items) |chunk| {
        if (std.mem.eql(u8, chunk.fourcc, "VP8L")) return decodeLossless(alloc, chunk.data, limits);
        if (std.mem.eql(u8, chunk.fourcc, "ALPH")) alpha = chunk.data;
        if (std.mem.eql(u8, chunk.fourcc, "VP8 ")) return decodeLossy(alloc, chunk.data, alpha, limits);
        if (std.mem.eql(u8, chunk.fourcc, "ANMF")) return decodeAnimationFrame(alloc, chunk.data, limits);
    }
    return error.UnsupportedImage;
}

/// First animation frame, placed on a transparent canvas of its own size.
fn decodeAnimationFrame(alloc: Allocator, frame: []const u8, limits: Limits) Error!Raster {
    if (frame.len < 16) return error.InvalidImage;
    var list: std.ArrayList(Chunk) = .empty;
    defer list.deinit(alloc);
    try chunks(frame, 16, frame.len, &list, alloc);
    var alpha: ?[]const u8 = null;
    for (list.items) |chunk| {
        if (std.mem.eql(u8, chunk.fourcc, "VP8L")) return decodeLossless(alloc, chunk.data, limits);
        if (std.mem.eql(u8, chunk.fourcc, "ALPH")) alpha = chunk.data;
        if (std.mem.eql(u8, chunk.fourcc, "VP8 ")) return decodeLossy(alloc, chunk.data, alpha, limits);
    }
    return error.InvalidImage;
}

fn decodeLossy(alloc: Allocator, data: []const u8, alpha_chunk: ?[]const u8, limits: Limits) Error!Raster {
    var image = try vp8.decode(alloc, data, limits);
    errdefer image.deinit(alloc);
    if (alpha_chunk) |chunk| try applyAlpha(alloc, &image, chunk);
    return image;
}

/// ALPH chunk: 1 header byte (reserved, preprocessing, filtering, compression)
/// then raw or VP8L-compressed alpha (stored in the green channel).
fn applyAlpha(alloc: Allocator, image: *Raster, chunk: []const u8) Error!void {
    @setRuntimeSafety(true);
    if (chunk.len < 1) return error.InvalidImage;
    const compression = chunk[0] & 3;
    const filtering = (chunk[0] >> 2) & 3;
    const w = image.width;
    const h = image.height;
    const plane = try alloc.alloc(u8, @as(usize, w) * h);
    defer alloc.free(plane);
    switch (compression) {
        0 => {
            if (chunk.len - 1 < plane.len) return error.InvalidImage;
            @memcpy(plane, chunk[1 .. 1 + plane.len]);
        },
        1 => {
            var reader = BitReader{ .data = chunk[1..] };
            const argb = try decodeImageStream(alloc, &reader, w, h, true);
            defer alloc.free(argb);
            for (plane, argb) |*a, pixel| a.* = @intCast((pixel >> 8) & 0xff);
        },
        else => return error.InvalidImage,
    }
    // Undo the spatial prediction filter (none, horizontal, vertical, gradient).
    if (filtering != 0) {
        var y: usize = 0;
        while (y < h) : (y += 1) {
            var x: usize = 0;
            while (x < w) : (x += 1) {
                const i = y * w + x;
                const predictor: u8 = if (x == 0 and y == 0)
                    0
                else if (y == 0)
                    plane[i - 1]
                else if (x == 0)
                    plane[i - w]
                else switch (filtering) {
                    1 => plane[i - 1],
                    2 => plane[i - w],
                    else => blk: {
                        const g = @as(i32, plane[i - 1]) + plane[i - w] - plane[i - w - 1];
                        break :blk @intCast(std.math.clamp(g, 0, 255));
                    },
                };
                plane[i] +%= predictor;
            }
        }
    }
    for (plane, 0..) |a, i| image.pixels[i * 4 + 3] = a;
}

// ---------------------------------------------------------------------------
// VP8L lossless

const BitReader = struct {
    data: []const u8,
    pos: usize = 0,
    bits: u64 = 0,
    count: u7 = 0,

    fn read(self: *BitReader, n: u7) Error!u32 {
        if (n == 0) return 0;
        while (self.count < n) {
            if (self.pos >= self.data.len) return error.InvalidImage;
            self.bits |= @as(u64, self.data[self.pos]) << @intCast(self.count);
            self.pos += 1;
            self.count += 8;
        }
        const value: u32 = @intCast(self.bits & ((@as(u64, 1) << @intCast(n)) - 1));
        self.bits >>= @intCast(n);
        self.count -= n;
        return value;
    }
};

const max_code_length = 15;

const PrefixCode = struct {
    counts: [max_code_length + 1]u16 = @splat(0),
    symbols: []u16 = &.{},
    /// Set when the code has exactly one symbol, which takes zero bits.
    single: ?u16 = null,

    fn deinit(self: *PrefixCode, alloc: Allocator) void {
        alloc.free(self.symbols);
    }

    fn build(alloc: Allocator, lengths: []const u8) Error!PrefixCode {
        var code: PrefixCode = .{};
        var used: usize = 0;
        var last: u16 = 0;
        for (lengths, 0..) |len, symbol| {
            if (len == 0) continue;
            code.counts[len] += 1;
            used += 1;
            last = @intCast(symbol);
        }
        if (used == 0) {
            // An all-zero code is treated as a single symbol 0.
            code.single = 0;
            return code;
        }
        if (used == 1) {
            code.single = last;
            return code;
        }
        var left: i32 = 1;
        for (1..max_code_length + 1) |len| {
            left <<= 1;
            left -= code.counts[len];
            if (left < 0) return error.InvalidImage;
        }
        if (left != 0) return error.InvalidImage; // the tree must be complete
        var offsets: [max_code_length + 2]u16 = undefined;
        offsets[1] = 0;
        for (1..max_code_length + 1) |len| offsets[len + 1] = offsets[len] + code.counts[len];
        code.symbols = try alloc.alloc(u16, used);
        for (lengths, 0..) |len, symbol| {
            if (len == 0) continue;
            code.symbols[offsets[len]] = @intCast(symbol);
            offsets[len] += 1;
        }
        return code;
    }

    fn decode(self: *const PrefixCode, reader: *BitReader) Error!u16 {
        if (self.single) |symbol| return symbol;
        var code: i32 = 0;
        var first: i32 = 0;
        var index: i32 = 0;
        for (1..max_code_length + 1) |len| {
            code |= @intCast(try reader.read(1));
            const count: i32 = self.counts[len];
            if (code - first < count) return self.symbols[@intCast(index + code - first)];
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        return error.InvalidImage;
    }
};

const code_length_order = [19]u8{ 17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };

fn readPrefixCode(alloc: Allocator, reader: *BitReader, alphabet_size: usize) Error!PrefixCode {
    const lengths = try alloc.alloc(u8, alphabet_size);
    defer alloc.free(lengths);
    @memset(lengths, 0);
    if (try reader.read(1) == 1) {
        const num_symbols = try reader.read(1) + 1;
        const first_bits: u7 = if (try reader.read(1) == 1) 8 else 1;
        const symbol0 = try reader.read(first_bits);
        if (symbol0 >= alphabet_size) return error.InvalidImage;
        lengths[symbol0] = 1;
        if (num_symbols == 2) {
            const symbol1 = try reader.read(8);
            if (symbol1 >= alphabet_size) return error.InvalidImage;
            lengths[symbol1] = 1;
        }
        return PrefixCode.build(alloc, lengths);
    }

    var code_length_lengths: [19]u8 = @splat(0);
    const num_code_lengths = 4 + try reader.read(4);
    if (num_code_lengths > 19) return error.InvalidImage;
    for (0..num_code_lengths) |i| code_length_lengths[code_length_order[i]] = @intCast(try reader.read(3));
    var length_code = try PrefixCode.build(alloc, &code_length_lengths);
    defer length_code.deinit(alloc);

    var max_symbol: usize = alphabet_size;
    if (try reader.read(1) == 1) {
        const length_nbits: u7 = @intCast(2 + 2 * try reader.read(3));
        max_symbol = 2 + try reader.read(length_nbits);
        if (max_symbol > alphabet_size) return error.InvalidImage;
    }
    var symbol: usize = 0;
    var previous: u8 = 8;
    while (symbol < alphabet_size) {
        if (max_symbol == 0) break;
        max_symbol -= 1;
        const code_len = try length_code.decode(reader);
        if (code_len < 16) {
            lengths[symbol] = @intCast(code_len);
            symbol += 1;
            if (code_len != 0) previous = @intCast(code_len);
            continue;
        }
        const repeat: usize = switch (code_len) {
            16 => 3 + try reader.read(2),
            17 => 3 + try reader.read(3),
            18 => 11 + try reader.read(7),
            else => return error.InvalidImage,
        };
        if (symbol + repeat > alphabet_size) return error.InvalidImage;
        @memset(lengths[symbol .. symbol + repeat], if (code_len == 16) previous else 0);
        symbol += repeat;
    }
    return PrefixCode.build(alloc, lengths);
}

const PrefixGroup = struct {
    codes: [5]PrefixCode,

    fn deinit(self: *PrefixGroup, alloc: Allocator) void {
        for (&self.codes) |*code| code.deinit(alloc);
    }
};

fn prefixValue(reader: *BitReader, prefix: u16) Error!u32 {
    if (prefix < 4) return prefix + 1;
    const extra: u7 = @intCast((prefix - 2) >> 1);
    if (extra > 30) return error.InvalidImage;
    const offset = (@as(u32, 2) + (prefix & 1)) << @intCast(extra);
    return offset + try reader.read(extra) + 1;
}

const distance_map = [120][2]i8{
    .{ 0, 1 },  .{ 1, 0 },  .{ 1, 1 },  .{ -1, 1 }, .{ 0, 2 },  .{ 2, 0 },  .{ 1, 2 },
    .{ -1, 2 }, .{ 2, 1 },  .{ -2, 1 }, .{ 2, 2 },  .{ -2, 2 }, .{ 0, 3 },  .{ 3, 0 },
    .{ 1, 3 },  .{ -1, 3 }, .{ 3, 1 },  .{ -3, 1 }, .{ 2, 3 },  .{ -2, 3 }, .{ 3, 2 },
    .{ -3, 2 }, .{ 0, 4 },  .{ 4, 0 },  .{ 1, 4 },  .{ -1, 4 }, .{ 4, 1 },  .{ -4, 1 },
    .{ 3, 3 },  .{ -3, 3 }, .{ 2, 4 },  .{ -2, 4 }, .{ 4, 2 },  .{ -4, 2 }, .{ 0, 5 },
    .{ 3, 4 },  .{ -3, 4 }, .{ 4, 3 },  .{ -4, 3 }, .{ 5, 0 },  .{ 1, 5 },  .{ -1, 5 },
    .{ 5, 1 },  .{ -5, 1 }, .{ 2, 5 },  .{ -2, 5 }, .{ 5, 2 },  .{ -5, 2 }, .{ 4, 4 },
    .{ -4, 4 }, .{ 3, 5 },  .{ -3, 5 }, .{ 5, 3 },  .{ -5, 3 }, .{ 0, 6 },  .{ 6, 0 },
    .{ 1, 6 },  .{ -1, 6 }, .{ 6, 1 },  .{ -6, 1 }, .{ 2, 6 },  .{ -2, 6 }, .{ 6, 2 },
    .{ -6, 2 }, .{ 4, 5 },  .{ -4, 5 }, .{ 5, 4 },  .{ -5, 4 }, .{ 3, 6 },  .{ -3, 6 },
    .{ 6, 3 },  .{ -6, 3 }, .{ 0, 7 },  .{ 7, 0 },  .{ 1, 7 },  .{ -1, 7 }, .{ 5, 5 },
    .{ -5, 5 }, .{ 7, 1 },  .{ -7, 1 }, .{ 4, 6 },  .{ -4, 6 }, .{ 6, 4 },  .{ -6, 4 },
    .{ 2, 7 },  .{ -2, 7 }, .{ 7, 2 },  .{ -7, 2 }, .{ 3, 7 },  .{ -3, 7 }, .{ 7, 3 },
    .{ -7, 3 }, .{ 5, 6 },  .{ -5, 6 }, .{ 6, 5 },  .{ -6, 5 }, .{ 8, 0 },  .{ 4, 7 },
    .{ -4, 7 }, .{ 7, 4 },  .{ -7, 4 }, .{ 8, 1 },  .{ 8, 2 },  .{ 6, 6 },  .{ -6, 6 },
    .{ 8, 3 },  .{ 5, 7 },  .{ -5, 7 }, .{ 7, 5 },  .{ -7, 5 }, .{ 8, 4 },  .{ 6, 7 },
    .{ -6, 7 }, .{ 7, 6 },  .{ -7, 6 }, .{ 8, 5 },  .{ 7, 7 },  .{ -7, 7 }, .{ 8, 6 },
    .{ 8, 7 },
};

/// Decodes one entropy-coded image of `width` x `height` ARGB pixels.
/// Only the main image (`is_main`) may carry meta prefix codes.
fn decodeEntropyImage(alloc: Allocator, reader: *BitReader, width: u32, height: u32, is_main: bool) Error![]u32 {
    @setRuntimeSafety(true);
    var cache_bits: u5 = 0;
    if (try reader.read(1) == 1) {
        const bits = try reader.read(4);
        if (bits < 1 or bits > 11) return error.InvalidImage;
        cache_bits = @intCast(bits);
    }
    const cache_size: usize = if (cache_bits == 0) 0 else @as(usize, 1) << cache_bits;

    var meta_bits: u5 = 0;
    var meta_image: []u32 = &.{};
    defer alloc.free(meta_image);
    var meta_width: u32 = 0;
    var group_count: usize = 1;
    if (is_main and try reader.read(1) == 1) {
        meta_bits = @intCast(try reader.read(3) + 2);
        meta_width = divRoundUp(width, meta_bits);
        meta_image = try decodeEntropyImage(alloc, reader, meta_width, divRoundUp(height, meta_bits), false);
        for (meta_image) |pixel| group_count = @max(group_count, ((pixel >> 8) & 0xffff) + 1);
    }

    const groups = try alloc.alloc(PrefixGroup, group_count);
    var groups_built: usize = 0;
    defer {
        for (groups[0..groups_built]) |*group| group.deinit(alloc);
        alloc.free(groups);
    }
    const alphabets = [5]usize{ 256 + 24 + cache_size, 256, 256, 256, 40 };
    while (groups_built < group_count) {
        var group: PrefixGroup = undefined;
        var built: usize = 0;
        errdefer for (group.codes[0..built]) |*code| code.deinit(alloc);
        for (alphabets, 0..) |size, i| {
            group.codes[i] = try readPrefixCode(alloc, reader, size);
            built += 1;
        }
        groups[groups_built] = group;
        groups_built += 1;
    }

    const cache = try alloc.alloc(u32, cache_size);
    defer alloc.free(cache);
    @memset(cache, 0);

    const total = @as(usize, width) * height;
    const pixels = try alloc.alloc(u32, total);
    errdefer alloc.free(pixels);
    var pos: usize = 0;
    while (pos < total) {
        const group = if (meta_bits == 0) &groups[0] else blk: {
            const x: u32 = @intCast(pos % width);
            const y: u32 = @intCast(pos / width);
            const index = (meta_image[(y >> meta_bits) * meta_width + (x >> meta_bits)] >> 8) & 0xffff;
            break :blk &groups[index];
        };
        const green = try group.codes[0].decode(reader);
        if (green < 256) {
            const red = try group.codes[1].decode(reader);
            const blue = try group.codes[2].decode(reader);
            const alpha = try group.codes[3].decode(reader);
            const argb = (@as(u32, alpha) << 24) | (@as(u32, red) << 16) | (@as(u32, green) << 8) | blue;
            pixels[pos] = argb;
            if (cache_size > 0) cache[cacheIndex(argb, cache_bits)] = argb;
            pos += 1;
        } else if (green < 256 + 24) {
            const length = try prefixValue(reader, green - 256);
            const distance_symbol = try group.codes[4].decode(reader);
            const distance_code = try prefixValue(reader, distance_symbol);
            var distance: i64 = if (distance_code > 120)
                @as(i64, distance_code) - 120
            else blk: {
                const offset = distance_map[distance_code - 1];
                break :blk @as(i64, offset[0]) + @as(i64, offset[1]) * width;
            };
            if (distance < 1) distance = 1;
            if (distance > pos or length > total - pos) return error.InvalidImage;
            var k: usize = 0;
            while (k < length) : (k += 1) {
                const argb = pixels[pos - @as(usize, @intCast(distance))];
                pixels[pos] = argb;
                if (cache_size > 0) cache[cacheIndex(argb, cache_bits)] = argb;
                pos += 1;
            }
        } else {
            const index = green - 280;
            if (index >= cache_size) return error.InvalidImage;
            const argb = cache[index];
            pixels[pos] = argb;
            cache[cacheIndex(argb, cache_bits)] = argb;
            pos += 1;
        }
    }
    return pixels;
}

fn cacheIndex(argb: u32, bits: u5) usize {
    return @intCast((0x1e35a7bd *% argb) >> @intCast(@as(u6, 32) - bits));
}

fn divRoundUp(value: u32, bits: u5) u32 {
    return (value + (@as(u32, 1) << bits) - 1) >> bits;
}

const Transform = union(enum) {
    predictor: struct { bits: u5, data: []u32 },
    color: struct { bits: u5, data: []u32 },
    subtract_green,
    color_indexing: struct { bits: u2, table: []u32 },

    fn deinit(self: Transform, alloc: Allocator) void {
        switch (self) {
            .predictor => |t| alloc.free(t.data),
            .color => |t| alloc.free(t.data),
            .color_indexing => |t| alloc.free(t.table),
            .subtract_green => {},
        }
    }
};

/// Header-less image stream: optional transforms followed by the image.
/// Returns `width` x `height` ARGB pixels.
fn decodeImageStream(alloc: Allocator, reader: *BitReader, width: u32, height: u32, has_transforms: bool) Error![]u32 {
    @setRuntimeSafety(true);
    var transforms: [4]Transform = undefined;
    var transform_count: usize = 0;
    defer for (transforms[0..transform_count]) |t| t.deinit(alloc);
    var seen = [4]bool{ false, false, false, false };
    var coded_width = width;
    while (has_transforms and try reader.read(1) == 1) {
        const kind = try reader.read(2);
        if (seen[kind]) return error.InvalidImage;
        seen[kind] = true;
        transforms[transform_count] = switch (kind) {
            0, 1 => blk: {
                const bits: u5 = @intCast(try reader.read(3) + 2);
                const data = try decodeEntropyImage(alloc, reader, divRoundUp(coded_width, bits), divRoundUp(height, bits), false);
                break :blk if (kind == 0) .{ .predictor = .{ .bits = bits, .data = data } } else .{ .color = .{ .bits = bits, .data = data } };
            },
            2 => .subtract_green,
            3 => blk: {
                const size = try reader.read(8) + 1;
                const table = try decodeEntropyImage(alloc, reader, size, 1, false);
                defer alloc.free(table);
                var i: usize = 1;
                while (i < table.len) : (i += 1) table[i] = addPixels(table[i], table[i - 1]);
                const bits: u2 = if (size <= 2) 3 else if (size <= 4) 2 else if (size <= 16) 1 else 0;
                // Pad to 256 entries so out-of-range indices read transparent black.
                const padded = try alloc.alloc(u32, 256);
                @memset(padded, 0);
                @memcpy(padded[0..table.len], table);
                coded_width = divRoundUp(coded_width, bits);
                break :blk .{ .color_indexing = .{ .bits = bits, .table = padded } };
            },
            else => unreachable,
        };
        transform_count += 1;
    }

    var pixels = try decodeEntropyImage(alloc, reader, coded_width, height, true);
    errdefer alloc.free(pixels);

    // Inverse transforms run in reverse order of appearance.
    var t = transform_count;
    while (t > 0) {
        t -= 1;
        switch (transforms[t]) {
            .subtract_green => for (pixels) |*p| {
                const green = (p.* >> 8) & 0xff;
                const red = ((p.* >> 16) + green) & 0xff;
                const blue = ((p.* & 0xff) + green) & 0xff;
                p.* = (p.* & 0xff00ff00) | (red << 16) | blue;
            },
            .predictor => |pred| inversePredictor(pixels, coded_width, height, pred.bits, pred.data),
            .color => |color| inverseColor(pixels, coded_width, height, color.bits, color.data),
            .color_indexing => |index| {
                const unbundled = try unbundle(alloc, pixels, coded_width, height, width, index.bits, index.table);
                alloc.free(pixels);
                pixels = unbundled;
                coded_width = width;
            },
        }
    }
    if (coded_width != width) return error.InvalidImage;
    return pixels;
}

fn unbundle(alloc: Allocator, packed_pixels: []const u32, packed_width: u32, height: u32, width: u32, bits: u2, table: []const u32) Error![]u32 {
    const out = try alloc.alloc(u32, @as(usize, width) * height);
    const per_pixel = @as(u32, 1) << bits;
    const value_bits: u5 = @intCast(@as(u32, 8) >> bits);
    const mask = (@as(u32, 1) << value_bits) - 1;
    var y: usize = 0;
    while (y < height) : (y += 1) {
        var x: u32 = 0;
        while (x < width) : (x += 1) {
            const packed_green = (packed_pixels[y * packed_width + x / per_pixel] >> 8) & 0xff;
            const index = (packed_green >> @intCast((x % per_pixel) * value_bits)) & mask;
            out[y * width + x] = table[index];
        }
    }
    return out;
}

fn addPixels(a: u32, b: u32) u32 {
    const ag = (a & 0xff00ff00) +% (b & 0xff00ff00);
    const rb = (a & 0x00ff00ff) +% (b & 0x00ff00ff);
    return (ag & 0xff00ff00) | (rb & 0x00ff00ff);
}

fn channel(p: u32, shift: u5) i32 {
    return @intCast((p >> shift) & 0xff);
}

fn average2(a: u32, b: u32) u32 {
    return (((a ^ b) & 0xfefefefe) >> 1) + (a & b);
}

fn select(l: u32, t: u32, tl: u32) u32 {
    var pl: i32 = 0;
    var pt: i32 = 0;
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        const estimate = channel(l, shift) + channel(t, shift) - channel(tl, shift);
        pl += @intCast(@abs(estimate - channel(l, shift)));
        pt += @intCast(@abs(estimate - channel(t, shift)));
    }
    return if (pl < pt) l else t;
}

fn clampAddSubtractFull(a: u32, b: u32, c: u32) u32 {
    var out: u32 = 0;
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        const v = std.math.clamp(channel(a, shift) + channel(b, shift) - channel(c, shift), 0, 255);
        out |= @as(u32, @intCast(v)) << shift;
    }
    return out;
}

fn clampAddSubtractHalf(a: u32, b: u32) u32 {
    var out: u32 = 0;
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        const ca = channel(a, shift);
        const v = std.math.clamp(ca + @divTrunc(ca - channel(b, shift), 2), 0, 255);
        out |= @as(u32, @intCast(v)) << shift;
    }
    return out;
}

fn inversePredictor(pixels: []u32, width: u32, height: u32, bits: u5, data: []const u32) void {
    @setRuntimeSafety(true);
    const block_width = divRoundUp(width, bits);
    var y: usize = 0;
    while (y < height) : (y += 1) {
        var x: usize = 0;
        while (x < width) : (x += 1) {
            const i = y * width + x;
            const prediction: u32 = if (y == 0 and x == 0)
                0xff000000
            else if (y == 0)
                pixels[i - 1]
            else if (x == 0)
                pixels[i - width]
            else blk: {
                const mode = (data[(y >> bits) * block_width + (x >> bits)] >> 8) & 0xf;
                const l = pixels[i - 1];
                const t = pixels[i - width];
                const tl = pixels[i - width - 1];
                const tr = pixels[i - width + 1];
                break :blk switch (mode) {
                    0 => 0xff000000,
                    1 => l,
                    2 => t,
                    3 => tr,
                    4 => tl,
                    5 => average2(average2(l, tr), t),
                    6 => average2(l, tl),
                    7 => average2(l, t),
                    8 => average2(tl, t),
                    9 => average2(t, tr),
                    10 => average2(average2(l, tl), average2(t, tr)),
                    11 => select(l, t, tl),
                    12 => clampAddSubtractFull(l, t, tl),
                    13 => clampAddSubtractHalf(average2(l, t), tl),
                    // Modes 14 and 15 are invalid; libwebp treats them as black.
                    else => 0xff000000,
                };
            };
            pixels[i] = addPixels(pixels[i], prediction);
        }
    }
}

fn colorDelta(t: u8, c: u8) i32 {
    return (@as(i32, @as(i8, @bitCast(t))) * @as(i32, @as(i8, @bitCast(c)))) >> 5;
}

fn inverseColor(pixels: []u32, width: u32, height: u32, bits: u5, data: []const u32) void {
    @setRuntimeSafety(true);
    const block_width = divRoundUp(width, bits);
    var y: usize = 0;
    while (y < height) : (y += 1) {
        var x: usize = 0;
        while (x < width) : (x += 1) {
            const element = data[(y >> bits) * block_width + (x >> bits)];
            const green_to_red: u8 = @intCast(element & 0xff);
            const green_to_blue: u8 = @intCast((element >> 8) & 0xff);
            const red_to_blue: u8 = @intCast((element >> 16) & 0xff);
            const p = &pixels[y * width + x];
            const green: u8 = @intCast((p.* >> 8) & 0xff);
            const red: i32 = channel(p.*, 16) + colorDelta(green_to_red, green);
            const red_byte: u8 = @intCast(red & 0xff);
            const blue: i32 = channel(p.*, 0) + colorDelta(green_to_blue, green) + colorDelta(red_to_blue, red_byte);
            p.* = (p.* & 0xff00ff00) | (@as(u32, red_byte) << 16) | @as(u32, @intCast(blue & 0xff));
        }
    }
}

fn decodeLossless(alloc: Allocator, data: []const u8, limits: Limits) Error!Raster {
    if (data.len < 5 or data[0] != 0x2f) return error.InvalidImage;
    var reader = BitReader{ .data = data[1..] };
    const width = try reader.read(14) + 1;
    const height = try reader.read(14) + 1;
    _ = try reader.read(1); // alpha hint; actual alpha values are authoritative
    if (try reader.read(3) != 0) return error.UnsupportedImage;
    try limits.check(width, height);
    const argb = try decodeImageStream(alloc, &reader, width, height, true);
    defer alloc.free(argb);
    var image = try Raster.init(alloc, width, height);
    for (argb, 0..) |p, i| {
        image.pixels[i * 4 ..][0..4].* = .{ @intCast((p >> 16) & 0xff), @intCast((p >> 8) & 0xff), @intCast(p & 0xff), @intCast(p >> 24) };
    }
    return image;
}

test "pixel arithmetic helpers" {
    try std.testing.expectEqual(@as(u32, 0x00010203), addPixels(0xff000102, 0x01010101));
    try std.testing.expectEqual(@as(u32, 0x40404040), average2(0x80808080, 0x00000000));
    try std.testing.expectEqual(@as(i32, -4), colorDelta(0x80, 0x01));
}

test "rejects non-webp and truncated containers" {
    try std.testing.expectError(error.InvalidImage, decode(std.testing.allocator, "RIFF\x04\x00\x00\x00WEBP", .default));
}
