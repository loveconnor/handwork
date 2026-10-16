//! JPEG decoding (ITU-T T.81): baseline and extended sequential Huffman,
//! progressive Huffman, any sampling factors, restart intervals,
//! grayscale, YCbCr, Adobe CMYK/YCCK, and EXIF orientation.
//! Arithmetic coding and lossless/hierarchical modes are rejected.
//!
//! Coefficients for every block are kept until the end of the image so
//! baseline and progressive files share one reconstruction path.

const std = @import("std");
const raster_mod = @import("../raster.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;
const Limits = raster_mod.Limits;

pub const Error = Allocator.Error || error{ InvalidImage, ImageTooLarge, UnsupportedImage };

/// Coefficient storage ceiling; larger images are refused before allocating.
const max_coefficient_bytes: usize = 320 * 1024 * 1024;

pub fn isJpeg(bytes: []const u8) bool {
    return bytes.len >= 3 and bytes[0] == 0xff and bytes[1] == 0xd8 and bytes[2] == 0xff;
}

const zigzag = [64]u8{
    0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
};

const HuffmanTable = struct {
    /// Fast path: (length << 8 | symbol) for codes up to `fast_bits` long.
    fast: [1 << fast_bits]u16 = @splat(0),
    max_code: [18]i32 = @splat(-1),
    val_offset: [17]i32 = @splat(0),
    values: [256]u8 = @splat(0),
    defined: bool = false,

    const fast_bits = 9;

    fn build(counts: [16]u8, symbols: []const u8) Error!HuffmanTable {
        var table: HuffmanTable = .{};
        var code: i32 = 0;
        var k: usize = 0;
        for (counts, 0..) |count, i| {
            const len = i + 1;
            table.val_offset[len] = @as(i32, @intCast(k)) - code;
            var n: usize = 0;
            while (n < count) : (n += 1) {
                if (k >= symbols.len or k >= 256) return error.InvalidImage;
                table.values[k] = symbols[k];
                if (len <= fast_bits) {
                    const shift: u4 = @intCast(fast_bits - len);
                    const start: usize = @as(usize, @intCast(code)) << shift;
                    const span: usize = @as(usize, 1) << shift;
                    if (start + span > table.fast.len) return error.InvalidImage;
                    for (table.fast[start .. start + span]) |*slot| slot.* = @as(u16, @intCast(len)) << 8 | symbols[k];
                }
                code += 1;
                k += 1;
            }
            table.max_code[len] = if (count > 0) code - 1 else -1;
            if (code > (@as(i32, 1) << @intCast(len))) return error.InvalidImage;
            code <<= 1;
        }
        table.max_code[17] = std.math.maxInt(i32);
        table.defined = true;
        return table;
    }
};

const BitReader = struct {
    data: []const u8,
    pos: usize,
    bits: u32 = 0,
    /// Valid bits in `bits`, left aligned; at most 32.
    count: u6 = 0,
    /// Set when entropy data ended at a marker; further reads return zeros.
    hit_marker: bool = false,

    fn fill(self: *BitReader) void {
        while (self.count <= 24) {
            var byte: u8 = 0;
            if (!self.hit_marker and self.pos < self.data.len) {
                byte = self.data[self.pos];
                if (byte == 0xff) {
                    const next: u8 = if (self.pos + 1 < self.data.len) self.data[self.pos + 1] else 0xd9;
                    if (next == 0x00) {
                        self.pos += 2;
                    } else {
                        self.hit_marker = true;
                        byte = 0;
                    }
                } else {
                    self.pos += 1;
                }
            }
            self.bits |= @as(u32, byte) << @intCast(24 - self.count);
            self.count += 8;
        }
    }

    fn peek(self: *BitReader, n: u5) u32 {
        if (self.count < n) self.fill();
        return self.bits >> @intCast(@as(u6, 32) - n);
    }

    fn consume(self: *BitReader, n: u5) void {
        // A full 32-bit shift is not representable; n never exceeds 16 here.
        self.bits <<= n;
        self.count -= n;
    }

    fn bit(self: *BitReader) u1 {
        const value: u1 = @intCast(self.peek(1));
        self.consume(1);
        return value;
    }

    fn receive(self: *BitReader, n: u5) u32 {
        if (n == 0) return 0;
        const value = self.peek(n);
        self.consume(n);
        return value;
    }

    fn receiveExtend(self: *BitReader, n: u5) i32 {
        if (n == 0) return 0;
        const value: i32 = @intCast(self.receive(n));
        const threshold = @as(i32, 1) << @intCast(n - 1);
        return if (value < threshold) value - (@as(i32, 1) << @intCast(n)) + 1 else value;
    }

    fn decode(self: *BitReader, table: *const HuffmanTable) Error!u8 {
        if (self.count < 16) self.fill();
        const fast = table.fast[self.bits >> (32 - HuffmanTable.fast_bits)];
        if (fast != 0) {
            self.consume(@intCast(fast >> 8));
            return @intCast(fast & 0xff);
        }
        var len: usize = HuffmanTable.fast_bits + 1;
        while (len <= 16) : (len += 1) {
            const code: i32 = @intCast(self.bits >> @intCast(32 - len));
            if (code <= table.max_code[len]) {
                self.consume(@intCast(len));
                const index = code + table.val_offset[len];
                if (index < 0 or index >= 256) return error.InvalidImage;
                return table.values[@intCast(index)];
            }
        }
        return error.InvalidImage;
    }

    /// Skips to just past the next RSTn marker and resets bit state.
    fn restart(self: *BitReader) void {
        self.bits = 0;
        self.count = 0;
        self.hit_marker = false;
        while (self.pos + 1 < self.data.len) {
            if (self.data[self.pos] == 0xff and self.data[self.pos + 1] >= 0xd0 and self.data[self.pos + 1] <= 0xd7) {
                self.pos += 2;
                return;
            }
            if (self.data[self.pos] == 0xff and self.data[self.pos + 1] != 0 and self.data[self.pos + 1] != 0xff) return;
            self.pos += 1;
        }
    }
};

const Component = struct {
    id: u8,
    h: u8,
    v: u8,
    quant_index: u8,
    blocks_per_line: usize = 0,
    block_rows: usize = 0,
    coefficients: []i16 = &.{},
    dc_table: u8 = 0,
    ac_table: u8 = 0,
    dc_prediction: i32 = 0,

    fn block(self: *Component, row: usize, col: usize) *[64]i16 {
        return self.coefficients[(row * self.blocks_per_line + col) * 64 ..][0..64];
    }
};

const Decoder = struct {
    alloc: Allocator,
    data: []const u8,
    quant: [4][64]u16 = @splat(@splat(1)),
    dc_tables: [4]HuffmanTable = @splat(.{}),
    ac_tables: [4]HuffmanTable = @splat(.{}),
    components: [4]Component = undefined,
    component_count: usize = 0,
    width: u32 = 0,
    height: u32 = 0,
    max_h: u8 = 1,
    max_v: u8 = 1,
    mcus_x: usize = 0,
    mcus_y: usize = 0,
    progressive: bool = false,
    restart_interval: u16 = 0,
    adobe_transform: ?u8 = null,
    saw_jfif: bool = false,
    orientation: u8 = 1,
    eob_run: u32 = 0,

    fn deinit(self: *Decoder) void {
        for (self.components[0..self.component_count]) |component| self.alloc.free(component.coefficients);
    }
};

pub fn decode(alloc: Allocator, bytes: []const u8, limits: Limits) Error!Raster {
    @setRuntimeSafety(true);
    if (!isJpeg(bytes)) return error.InvalidImage;
    var d = Decoder{ .alloc = alloc, .data = bytes };
    defer d.deinit();

    var pos: usize = 2;
    var frame_seen = false;
    while (true) {
        // Markers may be preceded by any number of 0xff fill bytes.
        while (pos < bytes.len and bytes[pos] != 0xff) pos += 1;
        while (pos < bytes.len and bytes[pos] == 0xff) pos += 1;
        if (pos >= bytes.len) break;
        const marker = bytes[pos];
        pos += 1;
        if (marker == 0xd9) break;
        if (marker == 0xd8 or (marker >= 0xd0 and marker <= 0xd7) or marker == 0x01) continue;
        if (pos + 2 > bytes.len) return error.InvalidImage;
        const length = std.mem.readInt(u16, bytes[pos..][0..2], .big);
        if (length < 2 or pos + length > bytes.len) return error.InvalidImage;
        const segment = bytes[pos + 2 .. pos + length];
        pos += length;
        switch (marker) {
            0xc0, 0xc1, 0xc2 => {
                if (frame_seen) return error.UnsupportedImage;
                frame_seen = true;
                d.progressive = marker == 0xc2;
                try parseFrame(&d, segment, limits);
            },
            0xc3, 0xc5...0xc7, 0xc9...0xcb, 0xcd...0xcf => return error.UnsupportedImage,
            0xc4 => try parseHuffmanTables(&d, segment),
            0xdb => try parseQuantTables(&d, segment),
            0xdd => {
                if (segment.len < 2) return error.InvalidImage;
                d.restart_interval = std.mem.readInt(u16, segment[0..2], .big);
            },
            0xda => {
                if (!frame_seen) return error.InvalidImage;
                pos = try decodeScan(&d, segment, pos);
            },
            0xe0 => if (segment.len >= 5 and std.mem.eql(u8, segment[0..5], "JFIF\x00")) {
                d.saw_jfif = true;
            },
            0xe1 => if (segment.len >= 6 and std.mem.eql(u8, segment[0..6], "Exif\x00\x00")) {
                d.orientation = parseExifOrientation(segment[6..]) orelse 1;
            },
            0xee => if (segment.len >= 12 and std.mem.eql(u8, segment[0..5], "Adobe")) {
                d.adobe_transform = segment[11];
            },
            else => {},
        }
    }
    if (!frame_seen) return error.InvalidImage;
    var image = try reconstruct(&d);
    errdefer image.deinit(alloc);
    return applyOrientation(alloc, image, d.orientation);
}

fn parseFrame(d: *Decoder, segment: []const u8, limits: Limits) Error!void {
    if (segment.len < 6) return error.InvalidImage;
    if (segment[0] != 8) return error.UnsupportedImage; // 12-bit precision
    d.height = std.mem.readInt(u16, segment[1..3], .big);
    d.width = std.mem.readInt(u16, segment[3..5], .big);
    // DNL-defined heights (0) are not supported.
    try limits.check(d.width, d.height);
    const count = segment[5];
    if (count != 1 and count != 3 and count != 4) return error.UnsupportedImage;
    if (segment.len < 6 + @as(usize, count) * 3) return error.InvalidImage;
    for (0..count) |i| {
        const base = 6 + i * 3;
        const h = segment[base + 1] >> 4;
        const v = segment[base + 1] & 15;
        if (h == 0 or h > 4 or v == 0 or v > 4 or segment[base + 2] > 3) return error.InvalidImage;
        d.components[i] = .{ .id = segment[base], .h = h, .v = v, .quant_index = segment[base + 2] };
        d.max_h = @max(d.max_h, h);
        d.max_v = @max(d.max_v, v);
    }
    d.component_count = count;
    d.mcus_x = (d.width + 8 * @as(usize, d.max_h) - 1) / (8 * @as(usize, d.max_h));
    d.mcus_y = (d.height + 8 * @as(usize, d.max_v) - 1) / (8 * @as(usize, d.max_v));
    var total: usize = 0;
    for (d.components[0..count]) |*c| {
        c.blocks_per_line = d.mcus_x * c.h;
        c.block_rows = d.mcus_y * c.v;
        total += c.blocks_per_line * c.block_rows * 64 * @sizeOf(i16);
    }
    if (total > max_coefficient_bytes) return error.ImageTooLarge;
    for (d.components[0..count]) |*c| {
        c.coefficients = try d.alloc.alloc(i16, c.blocks_per_line * c.block_rows * 64);
        @memset(c.coefficients, 0);
    }
}

fn parseHuffmanTables(d: *Decoder, segment: []const u8) Error!void {
    var p: usize = 0;
    while (p < segment.len) {
        if (p + 17 > segment.len) return error.InvalidImage;
        const class = segment[p] >> 4;
        const index = segment[p] & 15;
        if (class > 1 or index > 3) return error.InvalidImage;
        var counts: [16]u8 = undefined;
        @memcpy(&counts, segment[p + 1 .. p + 17]);
        var total: usize = 0;
        for (counts) |n| total += n;
        if (total > 256 or p + 17 + total > segment.len) return error.InvalidImage;
        const table = try HuffmanTable.build(counts, segment[p + 17 .. p + 17 + total]);
        if (class == 0) d.dc_tables[index] = table else d.ac_tables[index] = table;
        p += 17 + total;
    }
}

fn parseQuantTables(d: *Decoder, segment: []const u8) Error!void {
    var p: usize = 0;
    while (p < segment.len) {
        const precision = segment[p] >> 4;
        const index = segment[p] & 15;
        if (index > 3 or precision > 1) return error.InvalidImage;
        const size: usize = if (precision == 0) 64 else 128;
        if (p + 1 + size > segment.len) return error.InvalidImage;
        for (0..64) |i| {
            d.quant[index][zigzag[i]] = if (precision == 0)
                segment[p + 1 + i]
            else
                std.mem.readInt(u16, segment[p + 1 + i * 2 ..][0..2], .big);
        }
        p += 1 + size;
    }
}

const ScanParams = struct {
    components: [4]*Component,
    count: usize,
    ss: u8,
    se: u8,
    ah: u8,
    al: u8,
};

/// Decodes one scan whose entropy data starts at `data_start`; returns
/// the position where marker parsing resumes.
fn decodeScan(d: *Decoder, header: []const u8, data_start: usize) Error!usize {
    @setRuntimeSafety(true);
    if (header.len < 1) return error.InvalidImage;
    const count = header[0];
    if (count == 0 or count > 4 or header.len < 1 + @as(usize, count) * 2 + 3) return error.InvalidImage;
    var scan: ScanParams = undefined;
    scan.count = count;
    for (0..count) |i| {
        const id = header[1 + i * 2];
        const tables = header[2 + i * 2];
        const component = for (d.components[0..d.component_count]) |*c| {
            if (c.id == id) break c;
        } else return error.InvalidImage;
        component.dc_table = tables >> 4;
        component.ac_table = tables & 15;
        if (component.dc_table > 3 or component.ac_table > 3) return error.InvalidImage;
        scan.components[i] = component;
    }
    const tail = header[1 + @as(usize, count) * 2 ..];
    scan.ss = tail[0];
    scan.se = tail[1];
    scan.ah = tail[2] >> 4;
    scan.al = tail[2] & 15;
    if (d.progressive) {
        if (scan.se > 63 or scan.ss > scan.se or scan.al > 13) return error.InvalidImage;
        if (scan.ss == 0 and scan.se != 0) return error.InvalidImage;
        if (scan.ss > 0 and count != 1) return error.InvalidImage;
    } else {
        scan.ss = 0;
        scan.se = 63;
        scan.ah = 0;
        scan.al = 0;
    }

    var reader = BitReader{ .data = d.data, .pos = data_start };
    for (scan.components[0..count]) |c| c.dc_prediction = 0;
    d.eob_run = 0;

    var restart_countdown: u32 = d.restart_interval;
    if (count == 1) {
        // Non-interleaved: blocks in the component's own raster order,
        // covering only blocks that hold image pixels.
        const c = scan.components[0];
        const comp_w = (@as(usize, d.width) * c.h + d.max_h - 1) / d.max_h;
        const comp_h = (@as(usize, d.height) * c.v + d.max_v - 1) / d.max_v;
        const bw = (comp_w + 7) / 8;
        const bh = (comp_h + 7) / 8;
        var row: usize = 0;
        while (row < bh) : (row += 1) {
            var col: usize = 0;
            while (col < bw) : (col += 1) {
                if (d.restart_interval != 0) {
                    if (restart_countdown == 0) {
                        reader.restart();
                        c.dc_prediction = 0;
                        d.eob_run = 0;
                        restart_countdown = d.restart_interval;
                    }
                    restart_countdown -= 1;
                }
                try decodeBlock(d, &reader, c, c.block(row, col), scan);
            }
        }
    } else {
        var mcu_y: usize = 0;
        while (mcu_y < d.mcus_y) : (mcu_y += 1) {
            var mcu_x: usize = 0;
            while (mcu_x < d.mcus_x) : (mcu_x += 1) {
                if (d.restart_interval != 0) {
                    if (restart_countdown == 0) {
                        reader.restart();
                        for (scan.components[0..count]) |c| c.dc_prediction = 0;
                        d.eob_run = 0;
                        restart_countdown = d.restart_interval;
                    }
                    restart_countdown -= 1;
                }
                for (scan.components[0..count]) |c| {
                    var by: usize = 0;
                    while (by < c.v) : (by += 1) {
                        var bx: usize = 0;
                        while (bx < c.h) : (bx += 1) {
                            try decodeBlock(d, &reader, c, c.block(mcu_y * c.v + by, mcu_x * c.h + bx), scan);
                        }
                    }
                }
            }
        }
    }
    // Resume marker parsing where the entropy-coded data ended.
    var pos = reader.pos;
    while (pos + 1 < d.data.len) : (pos += 1) {
        if (d.data[pos] == 0xff and d.data[pos + 1] != 0 and !(d.data[pos + 1] >= 0xd0 and d.data[pos + 1] <= 0xd7)) break;
    }
    return pos;
}

fn decodeBlock(d: *Decoder, reader: *BitReader, c: *Component, coefficients: *[64]i16, scan: ScanParams) Error!void {
    @setRuntimeSafety(true);
    if (!d.progressive) {
        const dc = &d.dc_tables[c.dc_table];
        const ac = &d.ac_tables[c.ac_table];
        if (!dc.defined or !ac.defined) return error.InvalidImage;
        const t = try reader.decode(dc);
        if (t > 16) return error.InvalidImage;
        // Hostile streams can drift the predictor arbitrarily; values are
        // clamped on use, so wrapping only affects already-corrupt pixels.
        c.dc_prediction +%= reader.receiveExtend(@intCast(t));
        coefficients[0] = clampCoefficient(c.dc_prediction);
        var k: usize = 1;
        while (k < 64) {
            const rs = try reader.decode(ac);
            const r = rs >> 4;
            const s = rs & 15;
            if (s == 0) {
                if (r != 15) break;
                k += 16;
                continue;
            }
            k += r;
            if (k > 63) return error.InvalidImage;
            coefficients[zigzag[k]] = clampCoefficient(reader.receiveExtend(@intCast(s)));
            k += 1;
        }
        return;
    }

    const al: u5 = @intCast(scan.al);
    if (scan.ss == 0) {
        if (scan.ah == 0) {
            const dc = &d.dc_tables[c.dc_table];
            if (!dc.defined) return error.InvalidImage;
            const t = try reader.decode(dc);
            if (t > 16) return error.InvalidImage;
            // Hostile streams can drift the predictor arbitrarily; values are
            // clamped on use, so wrapping only affects already-corrupt pixels.
            c.dc_prediction +%= reader.receiveExtend(@intCast(t));
            coefficients[0] = clampCoefficient(c.dc_prediction *% (@as(i32, 1) << al));
        } else if (reader.bit() == 1) {
            coefficients[0] |= @as(i16, 1) << @intCast(al);
        }
        return;
    }

    const ac = &d.ac_tables[c.ac_table];
    if (!ac.defined) return error.InvalidImage;
    if (scan.ah == 0) {
        if (d.eob_run > 0) {
            d.eob_run -= 1;
            return;
        }
        var k: usize = scan.ss;
        while (k <= scan.se) {
            const rs = try reader.decode(ac);
            const r = rs >> 4;
            const s = rs & 15;
            if (s == 0) {
                if (r < 15) {
                    d.eob_run = (@as(u32, 1) << @intCast(r)) - 1;
                    if (r > 0) d.eob_run += reader.receive(@intCast(r));
                    break;
                }
                k += 16;
                continue;
            }
            k += r;
            if (k > 63) return error.InvalidImage;
            coefficients[zigzag[k]] = clampCoefficient(reader.receiveExtend(@intCast(s)) *% (@as(i32, 1) << al));
            k += 1;
        }
        return;
    }

    // Successive approximation refinement of AC coefficients.
    const p1: i16 = @as(i16, 1) << @intCast(al);
    const m1: i16 = -p1;
    var k: usize = scan.ss;
    if (d.eob_run == 0) {
        while (k <= scan.se) : (k += 1) {
            const rs = try reader.decode(ac);
            var r: i32 = rs >> 4;
            const s_bits = rs & 15;
            var value: i16 = 0;
            if (s_bits != 0) {
                value = if (reader.bit() == 1) p1 else m1;
            } else if (r != 15) {
                d.eob_run = @as(u32, 1) << @intCast(r);
                if (r > 0) d.eob_run += reader.receive(@intCast(r));
                break;
            }
            while (k <= scan.se) {
                const coefficient = &coefficients[zigzag[k]];
                if (coefficient.* != 0) {
                    if (reader.bit() == 1 and coefficient.* & p1 == 0) {
                        coefficient.* +|= if (coefficient.* >= 0) p1 else m1;
                    }
                } else {
                    r -= 1;
                    if (r < 0) break;
                }
                k += 1;
            }
            if (value != 0) {
                if (k > 63) return error.InvalidImage;
                coefficients[zigzag[k]] = value;
            }
        }
    }
    if (d.eob_run > 0) {
        while (k <= scan.se) : (k += 1) {
            const coefficient = &coefficients[zigzag[k]];
            if (coefficient.* != 0 and reader.bit() == 1 and coefficient.* & p1 == 0) {
                coefficient.* +|= if (coefficient.* >= 0) p1 else m1;
            }
        }
        d.eob_run -= 1;
    }
}

fn clampCoefficient(value: i32) i16 {
    return @intCast(std.math.clamp(value, std.math.minInt(i16), std.math.maxInt(i16)));
}

/// idct_basis[x][u] = C(u)/2 * cos((2x + 1) * u * pi / 16)
const idct_basis: [8][8]f32 = blk: {
    @setEvalBranchQuota(10_000);
    var table: [8][8]f32 = undefined;
    for (0..8) |x| {
        for (0..8) |u| {
            const cu: f64 = if (u == 0) 1.0 / @sqrt(2.0) else 1.0;
            table[x][u] = @floatCast(cu / 2.0 * @cos(@as(f64, @floatFromInt((2 * x + 1) * u)) * std.math.pi / 16.0));
        }
    }
    break :blk table;
};

/// Inverse DCT of one dequantized block into 8x8 samples (level shifted).
fn idctBlock(coefficients: *const [64]i16, quant: *const [64]u16, out: *[64]u8) void {
    var input: [64]f32 = undefined;
    var nonzero_columns: u8 = 0;
    for (0..64) |i| {
        input[i] = @as(f32, @floatFromInt(coefficients[i])) * @as(f32, @floatFromInt(quant[i]));
        if (coefficients[i] != 0) nonzero_columns |= @as(u8, 1) << @intCast(i % 8);
    }
    // Columns: tmp[y][u] = sum_v basis[y][v] * input[v][u]
    var tmp: [64]f32 = @splat(0);
    for (0..8) |u| {
        if (nonzero_columns & (@as(u8, 1) << @intCast(u)) == 0) continue;
        for (0..8) |y| {
            var sum: f32 = 0;
            for (0..8) |v| sum += idct_basis[y][v] * input[v * 8 + u];
            tmp[y * 8 + u] = sum;
        }
    }
    // Rows: out[y][x] = sum_u basis[x][u] * tmp[y][u]
    for (0..8) |y| {
        for (0..8) |x| {
            var sum: f32 = 0;
            for (0..8) |u| {
                if (nonzero_columns & (@as(u8, 1) << @intCast(u)) == 0) continue;
                sum += idct_basis[x][u] * tmp[y * 8 + u];
            }
            out[y * 8 + x] = @intFromFloat(std.math.clamp(@round(sum + 128.0), 0.0, 255.0));
        }
    }
}

fn reconstruct(d: *Decoder) Error!Raster {
    @setRuntimeSafety(true);
    const alloc = d.alloc;
    // Expand each component to a full-resolution sample plane.
    var planes: [4][]u8 = undefined;
    var planes_made: usize = 0;
    defer for (planes[0..planes_made]) |plane| alloc.free(plane);
    for (d.components[0..d.component_count], 0..) |*c, ci| {
        const plane_w = c.blocks_per_line * 8;
        const plane_h = c.block_rows * 8;
        const samples = try alloc.alloc(u8, plane_w * plane_h);
        defer alloc.free(samples);
        var block_samples: [64]u8 = undefined;
        var row: usize = 0;
        while (row < c.block_rows) : (row += 1) {
            var col: usize = 0;
            while (col < c.blocks_per_line) : (col += 1) {
                idctBlock(c.block(row, col), &d.quant[c.quant_index], &block_samples);
                for (0..8) |y| @memcpy(samples[(row * 8 + y) * plane_w + col * 8 ..][0..8], block_samples[y * 8 ..][0..8]);
            }
        }
        // Upsample with linear interpolation between sample centers.
        const plane = try alloc.alloc(u8, @as(usize, d.width) * d.height);
        planes[ci] = plane;
        planes_made += 1;
        const sx = @as(f32, @floatFromInt(c.h)) / @as(f32, @floatFromInt(d.max_h));
        const sy = @as(f32, @floatFromInt(c.v)) / @as(f32, @floatFromInt(d.max_v));
        const valid_w = @max(1, (@as(usize, d.width) * c.h + d.max_h - 1) / d.max_h);
        const valid_h = @max(1, (@as(usize, d.height) * c.v + d.max_v - 1) / d.max_v);
        var y: usize = 0;
        while (y < d.height) : (y += 1) {
            if (sx == 1 and sy == 1) {
                @memcpy(plane[y * d.width ..][0..d.width], samples[y * plane_w ..][0..d.width]);
                continue;
            }
            const fy = @max(0, (@as(f32, @floatFromInt(y)) + 0.5) * sy - 0.5);
            const y0: usize = @min(@as(usize, @intFromFloat(fy)), valid_h - 1);
            const y1 = @min(y0 + 1, valid_h - 1);
            const ty = fy - @floor(fy);
            var x: usize = 0;
            while (x < d.width) : (x += 1) {
                const fx = @max(0, (@as(f32, @floatFromInt(x)) + 0.5) * sx - 0.5);
                const x0: usize = @min(@as(usize, @intFromFloat(fx)), valid_w - 1);
                const x1 = @min(x0 + 1, valid_w - 1);
                const tx = fx - @floor(fx);
                const a = @as(f32, @floatFromInt(samples[y0 * plane_w + x0]));
                const b = @as(f32, @floatFromInt(samples[y0 * plane_w + x1]));
                const cc = @as(f32, @floatFromInt(samples[y1 * plane_w + x0]));
                const dd = @as(f32, @floatFromInt(samples[y1 * plane_w + x1]));
                const top = a + (b - a) * tx;
                const bottom = cc + (dd - cc) * tx;
                plane[y * d.width + x] = @intFromFloat(@round(top + (bottom - top) * ty));
            }
        }
    }

    var out = try Raster.init(alloc, d.width, d.height);
    errdefer out.deinit(alloc);
    const transform: u8 = d.adobe_transform orelse switch (d.component_count) {
        3 => blk: {
            // Without an Adobe marker, RGB-labeled components mean RGB.
            const ids = [3]u8{ d.components[0].id, d.components[1].id, d.components[2].id };
            break :blk if (!d.saw_jfif and ids[0] == 'R' and ids[1] == 'G' and ids[2] == 'B') 0 else 1;
        },
        4 => 0,
        else => 0,
    };
    const n = @as(usize, d.width) * d.height;
    for (0..n) |i| {
        const px = out.pixels[i * 4 ..][0..4];
        switch (d.component_count) {
            1 => px.* = .{ planes[0][i], planes[0][i], planes[0][i], 255 },
            3 => px.* = if (transform == 0)
                .{ planes[0][i], planes[1][i], planes[2][i], 255 }
            else
                ycc(planes[0][i], planes[1][i], planes[2][i]),
            4 => {
                const k: u32 = planes[3][i];
                if (transform == 2) {
                    const rgb = ycc(planes[0][i], planes[1][i], planes[2][i]);
                    px.* = .{ blend(255 - rgb[0], k), blend(255 - rgb[1], k), blend(255 - rgb[2], k), 255 };
                } else {
                    px.* = .{ blend(planes[0][i], k), blend(planes[1][i], k), blend(planes[2][i], k), 255 };
                }
            },
            else => unreachable,
        }
    }
    return out;
}

fn ycc(y: u8, cb: u8, cr: u8) [4]u8 {
    const yf = @as(f32, @floatFromInt(y));
    const cbf = @as(f32, @floatFromInt(cb)) - 128.0;
    const crf = @as(f32, @floatFromInt(cr)) - 128.0;
    return .{
        clampByte(yf + 1.402 * crf),
        clampByte(yf - 0.344136 * cbf - 0.714136 * crf),
        clampByte(yf + 1.772 * cbf),
        255,
    };
}

fn clampByte(value: f32) u8 {
    return @intFromFloat(std.math.clamp(@round(value), 0.0, 255.0));
}

fn blend(channel: anytype, k: u32) u8 {
    return @intCast((@as(u32, channel) * k + 127) / 255);
}

/// Reads the IFD0 orientation tag from an EXIF TIFF block.
fn parseExifOrientation(tiff: []const u8) ?u8 {
    if (tiff.len < 8) return null;
    const endian: std.builtin.Endian = if (std.mem.eql(u8, tiff[0..2], "II")) .little else if (std.mem.eql(u8, tiff[0..2], "MM")) .big else return null;
    const ifd = std.mem.readInt(u32, tiff[4..8], endian);
    if (ifd + 2 > tiff.len) return null;
    const entries = std.mem.readInt(u16, tiff[ifd..][0..2], endian);
    var i: usize = 0;
    while (i < entries) : (i += 1) {
        const at = ifd + 2 + i * 12;
        if (at + 12 > tiff.len) return null;
        if (std.mem.readInt(u16, tiff[at..][0..2], endian) != 0x0112) continue;
        const value = std.mem.readInt(u16, tiff[at + 8 ..][0..2], endian);
        return if (value >= 1 and value <= 8) @intCast(value) else null;
    }
    return null;
}

/// Rotates/flips decoded pixels so the image appears as the camera meant.
fn applyOrientation(alloc: Allocator, image: Raster, orientation: u8) Error!Raster {
    if (orientation <= 1 or orientation > 8) return image;
    var source = image;
    defer source.deinit(alloc);
    const swaps = orientation >= 5;
    var out = try Raster.init(alloc, if (swaps) source.height else source.width, if (swaps) source.width else source.height);
    const w = source.width;
    const h = source.height;
    var y: u32 = 0;
    while (y < h) : (y += 1) {
        var x: u32 = 0;
        while (x < w) : (x += 1) {
            const dest: [2]u32 = switch (orientation) {
                2 => .{ w - 1 - x, y },
                3 => .{ w - 1 - x, h - 1 - y },
                4 => .{ x, h - 1 - y },
                5 => .{ y, x },
                6 => .{ h - 1 - y, x },
                7 => .{ h - 1 - y, w - 1 - x },
                8 => .{ y, w - 1 - x },
                else => unreachable,
            };
            out.pixel(dest[0], dest[1]).* = source.pixel(x, y).*;
        }
    }
    return out;
}

test "huffman tables reject over-subscribed code lengths" {
    var counts: [16]u8 = @splat(0);
    counts[0] = 3; // three 1-bit codes cannot exist
    try std.testing.expectError(error.InvalidImage, HuffmanTable.build(counts, &.{ 1, 2, 3 }));
}

test "idct of a DC-only block is flat" {
    var coefficients: [64]i16 = @splat(0);
    coefficients[0] = 8; // DC 8 * quant 8 = 64 -> sample offset 64/8 = 8
    var quant: [64]u16 = @splat(8);
    var out: [64]u8 = undefined;
    idctBlock(&coefficients, &quant, &out);
    for (out) |sample| try std.testing.expectEqual(@as(u8, 136), sample);
}

test "EXIF orientation is read in both byte orders" {
    const le = "II*\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00";
    try std.testing.expectEqual(@as(?u8, 6), parseExifOrientation(le));
    const be = "MM\x00*\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x03\x00\x00";
    try std.testing.expectEqual(@as(?u8, 3), parseExifOrientation(be));
}

test "orientation 6 rotates clockwise" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 2, 1);
    image.pixel(0, 0).* = .{ 1, 0, 0, 255 };
    image.pixel(1, 0).* = .{ 2, 0, 0, 255 };
    var rotated = try applyOrientation(alloc, image, 6);
    defer rotated.deinit(alloc);
    try std.testing.expectEqual(@as(u32, 1), rotated.width);
    try std.testing.expectEqual(@as(u8, 1), rotated.pixel(0, 0)[0]);
    try std.testing.expectEqual(@as(u8, 2), rotated.pixel(0, 1)[0]);
}
