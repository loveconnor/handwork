//! Bounds-checked zlib/DEFLATE decompression (RFC 1950/1951) for image
//! payloads. Every read and back-reference is validated and reported as
//! `error.InvalidImage`, so a hostile stream can only fail, never read or
//! write outside its buffers. (Zig 0.16's std inflater trips an integer
//! overflow on some malformed streams, which release builds do not check.)

const std = @import("std");

const Allocator = std.mem.Allocator;

pub const Error = Allocator.Error || error{InvalidImage};

const BitInput = struct {
    data: []const u8,
    pos: usize = 0,
    bits: u64 = 0,
    count: u7 = 0,

    fn need(self: *BitInput, n: u7) Error!void {
        while (self.count < n) {
            if (self.pos >= self.data.len) return error.InvalidImage;
            self.bits |= @as(u64, self.data[self.pos]) << @intCast(self.count);
            self.pos += 1;
            self.count += 8;
        }
    }

    fn take(self: *BitInput, n: u7) Error!u32 {
        if (n == 0) return 0;
        try self.need(n);
        const value: u32 = @intCast(self.bits & ((@as(u64, 1) << @intCast(n)) - 1));
        self.bits >>= @intCast(n);
        self.count -= n;
        return value;
    }

    fn alignToByte(self: *BitInput) void {
        const drop: u7 = self.count % 8;
        self.bits >>= @intCast(drop);
        self.count -= drop;
    }
};

const max_bits = 15;

/// Canonical Huffman decoder: counts per length plus symbols in code order.
const Huffman = struct {
    counts: [max_bits + 1]u16 = @splat(0),
    symbols: [288]u16 = undefined,

    fn init(lengths: []const u8) Error!Huffman {
        var h: Huffman = .{};
        for (lengths) |len| h.counts[len] += 1;
        h.counts[0] = 0;
        var left: i32 = 1;
        for (1..max_bits + 1) |len| {
            left <<= 1;
            left -= h.counts[len];
            if (left < 0) return error.InvalidImage; // over-subscribed
        }
        var offsets: [max_bits + 2]u16 = undefined;
        offsets[1] = 0;
        for (1..max_bits + 1) |len| offsets[len + 1] = offsets[len] + h.counts[len];
        for (lengths, 0..) |len, symbol| {
            if (len != 0) {
                h.symbols[offsets[len]] = @intCast(symbol);
                offsets[len] += 1;
            }
        }
        return h;
    }

    fn decode(self: *const Huffman, input: *BitInput) Error!u16 {
        var code: i32 = 0;
        var first: i32 = 0;
        var index: i32 = 0;
        for (1..max_bits + 1) |len| {
            code |= @intCast(try input.take(1));
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

const length_base = [_]u16{ 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 };
const length_extra = [_]u5{ 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 };
const dist_base = [_]u16{ 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 };
const dist_extra = [_]u5{ 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 };

/// Inflates a zlib stream into exactly `expected_len` bytes. Streams that
/// end early, overrun, or fail the Adler-32 check are rejected.
pub fn zlibDecompress(alloc: Allocator, data: []const u8, expected_len: usize) Error![]u8 {
    @setRuntimeSafety(true);
    if (data.len < 6) return error.InvalidImage;
    const cmf = data[0];
    const flg = data[1];
    if (cmf & 0x0f != 8 or (@as(u16, cmf) << 8 | flg) % 31 != 0 or flg & 0x20 != 0) return error.InvalidImage;

    const out = try alloc.alloc(u8, expected_len);
    errdefer alloc.free(out);
    var written: usize = 0;
    var input = BitInput{ .data = data[2..] };

    while (true) {
        const final = try input.take(1);
        const kind = try input.take(2);
        switch (kind) {
            0 => {
                input.alignToByte();
                const len = try input.take(16);
                const nlen = try input.take(16);
                if (len != (~nlen & 0xffff)) return error.InvalidImage;
                // Remaining buffered bits are whole bytes after alignment.
                var remaining: usize = len;
                while (remaining > 0 and input.count >= 8) : (remaining -= 1) {
                    if (written >= out.len) return error.InvalidImage;
                    out[written] = @intCast(try input.take(8));
                    written += 1;
                }
                if (remaining > input.data.len - input.pos or remaining > out.len - written) return error.InvalidImage;
                @memcpy(out[written .. written + remaining], input.data[input.pos .. input.pos + remaining]);
                written += remaining;
                input.pos += remaining;
            },
            1 => {
                var lengths: [288 + 32]u8 = undefined;
                @memset(lengths[0..144], 8);
                @memset(lengths[144..256], 9);
                @memset(lengths[256..280], 7);
                @memset(lengths[280..288], 8);
                @memset(lengths[288..], 5);
                const lit = try Huffman.init(lengths[0..288]);
                const dist = try Huffman.init(lengths[288..320]);
                written = try inflateBlock(&input, &lit, &dist, out, written);
            },
            2 => {
                const tables = try readDynamicTables(&input);
                written = try inflateBlock(&input, &tables.lit, &tables.dist, out, written);
            },
            else => return error.InvalidImage,
        }
        if (final == 1) break;
    }
    if (written != out.len) return error.InvalidImage;

    input.alignToByte();
    var trailer: [4]u8 = undefined;
    for (&trailer) |*b| b.* = @intCast(try input.take(8));
    if (std.mem.readInt(u32, &trailer, .big) != std.hash.Adler32.hash(out)) return error.InvalidImage;
    return out;
}

fn readDynamicTables(input: *BitInput) Error!struct { lit: Huffman, dist: Huffman } {
    const hlit = try input.take(5) + 257;
    const hdist = try input.take(5) + 1;
    const hclen = try input.take(4) + 4;
    if (hlit > 286 or hdist > 30) return error.InvalidImage;
    const order = [_]u8{ 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 };
    var code_lengths: [19]u8 = @splat(0);
    for (0..hclen) |i| code_lengths[order[i]] = @intCast(try input.take(3));
    const code_huffman = try Huffman.init(&code_lengths);

    var lengths: [286 + 30]u8 = @splat(0);
    var i: usize = 0;
    while (i < hlit + hdist) {
        const symbol = try code_huffman.decode(input);
        switch (symbol) {
            0...15 => {
                lengths[i] = @intCast(symbol);
                i += 1;
            },
            16, 17, 18 => {
                const repeat: usize = switch (symbol) {
                    16 => 3 + try input.take(2),
                    17 => 3 + try input.take(3),
                    else => 11 + try input.take(7),
                };
                if (symbol == 16 and i == 0) return error.InvalidImage;
                const value: u8 = if (symbol == 16) lengths[i - 1] else 0;
                if (i + repeat > hlit + hdist) return error.InvalidImage;
                @memset(lengths[i .. i + repeat], value);
                i += repeat;
            },
            else => return error.InvalidImage,
        }
    }
    if (lengths[256] == 0) return error.InvalidImage; // no end-of-block code
    return .{ .lit = try Huffman.init(lengths[0..hlit]), .dist = try Huffman.init(lengths[hlit .. hlit + hdist]) };
}

fn inflateBlock(input: *BitInput, lit: *const Huffman, dist: *const Huffman, out: []u8, start: usize) Error!usize {
    @setRuntimeSafety(true);
    var written = start;
    while (true) {
        const symbol = try lit.decode(input);
        if (symbol < 256) {
            if (written >= out.len) return error.InvalidImage;
            out[written] = @intCast(symbol);
            written += 1;
            continue;
        }
        if (symbol == 256) return written;
        const length_index = symbol - 257;
        if (length_index >= length_base.len) return error.InvalidImage;
        const length = length_base[length_index] + try input.take(length_extra[length_index]);
        const dist_symbol = try dist.decode(input);
        if (dist_symbol >= dist_base.len) return error.InvalidImage;
        const distance = dist_base[dist_symbol] + try input.take(dist_extra[dist_symbol]);
        if (distance > written or length > out.len - written) return error.InvalidImage;
        // Overlapping copies repeat recent bytes; copy forward one at a time.
        var k: usize = 0;
        while (k < length) : (k += 1) {
            out[written] = out[written - distance];
            written += 1;
        }
    }
}

fn compressForTest(alloc: Allocator, plain: []const u8, level: std.compress.flate.Compress.Options) ![]u8 {
    var output = try std.Io.Writer.Allocating.initCapacity(alloc, 64);
    defer output.deinit();
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var compressor = try std.compress.flate.Compress.init(&output.writer, &window, .zlib, level);
    try compressor.writer.writeAll(plain);
    try compressor.finish();
    return output.toOwnedSlice();
}

test "round-trips data compressed by the standard library" {
    const alloc = std.testing.allocator;
    var plain: [20_000]u8 = undefined;
    var prng = std.Random.DefaultPrng.init(7);
    for (&plain, 0..) |*b, i| b.* = if (i % 3 == 0) prng.random().int(u8) else @intCast(i % 7);
    for ([_]std.compress.flate.Compress.Options{ .fastest, .default, .best }) |level| {
        const compressed = try compressForTest(alloc, &plain, level);
        defer alloc.free(compressed);
        const inflated = try zlibDecompress(alloc, compressed, plain.len);
        defer alloc.free(inflated);
        try std.testing.expectEqualSlices(u8, &plain, inflated);
    }
}

test "stored blocks and checksum validation" {
    const alloc = std.testing.allocator;
    // zlib header, final stored block "abc", Adler-32 of "abc".
    const stored = "\x78\x01\x01\x03\x00\xfc\xffabc\x02\x4d\x01\x27";
    const inflated = try zlibDecompress(alloc, stored, 3);
    defer alloc.free(inflated);
    try std.testing.expectEqualStrings("abc", inflated);
    var corrupt = stored.*;
    corrupt[corrupt.len - 1] ^= 1;
    try std.testing.expectError(error.InvalidImage, zlibDecompress(alloc, &corrupt, 3));
    try std.testing.expectError(error.InvalidImage, zlibDecompress(alloc, stored, 4));
    try std.testing.expectError(error.InvalidImage, zlibDecompress(alloc, stored, 2));
}

test "rejects streams that end before the expected length" {
    const alloc = std.testing.allocator;
    // A final fixed-Huffman block holding only end-of-block.
    const bad = "\x78\x01\x03\x02\x00\x00\x00\x00\x01";
    try std.testing.expectError(error.InvalidImage, zlibDecompress(alloc, bad, 10));
}
