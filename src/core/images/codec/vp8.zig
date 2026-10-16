//! VP8 key-frame decoding (RFC 6386) for lossy WebP images.
//!
//! Structure and edge handling follow the RFC's reference decoder
//! ("dixie"): every macroblock is predicted from unfiltered neighbors in a
//! bordered frame buffer, then the loop filter runs over the finished
//! frame in raster order, which matches the reference's one-row-delayed
//! filtering. Inter frames never occur in still WebP images and are
//! rejected.

const std = @import("std");
const raster_mod = @import("../raster.zig");
const tables = @import("vp8_tables.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;
const Limits = raster_mod.Limits;

pub const Error = Allocator.Error || error{ InvalidImage, ImageTooLarge, UnsupportedImage };

const BoolDecoder = struct {
    input: []const u8,
    pos: usize = 0,
    range: u32 = 255,
    value: u32 = 0,
    bit_count: u32 = 0,

    fn init(input: []const u8) BoolDecoder {
        var d = BoolDecoder{ .input = input };
        if (input.len >= 2) {
            d.value = (@as(u32, input[0]) << 8) | input[1];
            d.pos = 2;
        } else {
            d.pos = input.len;
        }
        return d;
    }

    fn get(self: *BoolDecoder, probability: u8) u1 {
        const split = 1 + (((self.range - 1) * probability) >> 8);
        const big_split = split << 8;
        var decoded: u1 = 0;
        if (self.value >= big_split) {
            decoded = 1;
            self.range -= split;
            self.value -= big_split;
        } else {
            self.range = split;
        }
        while (self.range < 128) {
            self.value <<= 1;
            self.range <<= 1;
            self.bit_count += 1;
            if (self.bit_count == 8) {
                self.bit_count = 0;
                // Past the end the stream reads as zeros, as in the reference.
                if (self.pos < self.input.len) {
                    self.value |= self.input[self.pos];
                    self.pos += 1;
                }
            }
        }
        return decoded;
    }

    fn bit(self: *BoolDecoder) u1 {
        return self.get(128);
    }

    fn uint(self: *BoolDecoder, bits: u5) u32 {
        var z: u32 = 0;
        var i: u5 = bits;
        while (i > 0) {
            i -= 1;
            z |= @as(u32, self.bit()) << i;
        }
        return z;
    }

    fn int(self: *BoolDecoder, bits: u5) i32 {
        const magnitude: i32 = @intCast(self.uint(bits));
        return if (self.bit() == 1) -magnitude else magnitude;
    }

    fn maybeInt(self: *BoolDecoder, bits: u5) i32 {
        return if (self.bit() == 1) self.int(bits) else 0;
    }

    /// Tree decoding: positive entries index the next node pair, others
    /// are negated leaves (leaf 0 is stored as 0).
    fn tree(self: *BoolDecoder, t: []const i8, probs: []const u8) u8 {
        var i: usize = 0;
        while (true) {
            const next = t[i + self.get(probs[i >> 1])];
            if (next <= 0) return @intCast(-next);
            i = @intCast(next);
        }
    }
};

// Prediction modes (macroblock and subblock share the low numbers).
const DC_PRED = 0;
const V_PRED = 1;
const H_PRED = 2;
const TM_PRED = 3;
const B_PRED = 4;

const B_DC_PRED = 0;
const B_TM_PRED = 1;
const B_VE_PRED = 2;
const B_HE_PRED = 3;
const B_LD_PRED = 4;
const B_RD_PRED = 5;
const B_VR_PRED = 6;
const B_VL_PRED = 7;
const B_HD_PRED = 8;
const B_HU_PRED = 9;

const kf_y_mode_tree = [_]i8{ -B_PRED, 2, 4, 6, -DC_PRED, -V_PRED, -H_PRED, -TM_PRED };
const kf_y_mode_probs = [_]u8{ 145, 156, 163, 128 };
const uv_mode_tree = [_]i8{ -DC_PRED, 2, -V_PRED, 4, -H_PRED, -TM_PRED };
const kf_uv_mode_probs = [_]u8{ 142, 114, 183 };
const b_mode_tree = [_]i8{
    -B_DC_PRED, 2,
    -B_TM_PRED, 4,
    -B_VE_PRED, 6,
    8,          12,
    -B_HE_PRED, 10,
    -B_RD_PRED, -B_VR_PRED,
    -B_LD_PRED, 14,
    -B_VL_PRED, 16,
    -B_HD_PRED, -B_HU_PRED,
};

const dc_q_lookup = [128]u16{
    4,   5,   6,   7,   8,   9,   10,  10,  11,  12,  13,  14,  15,  16,  17,  17,
    18,  19,  20,  20,  21,  21,  22,  22,  23,  23,  24,  25,  25,  26,  27,  28,
    29,  30,  31,  32,  33,  34,  35,  36,  37,  37,  38,  39,  40,  41,  42,  43,
    44,  45,  46,  46,  47,  48,  49,  50,  51,  52,  53,  54,  55,  56,  57,  58,
    59,  60,  61,  62,  63,  64,  65,  66,  67,  68,  69,  70,  71,  72,  73,  74,
    75,  76,  76,  77,  78,  79,  80,  81,  82,  83,  84,  85,  86,  87,  88,  89,
    91,  93,  95,  96,  98,  100, 101, 102, 104, 106, 108, 110, 112, 114, 116, 118,
    122, 124, 126, 128, 130, 132, 134, 136, 138, 140, 143, 145, 148, 151, 154, 157,
};

const ac_q_lookup = [128]u16{
    4,   5,   6,   7,   8,   9,   10,  11,  12,  13,  14,  15,  16,  17,  18,  19,
    20,  21,  22,  23,  24,  25,  26,  27,  28,  29,  30,  31,  32,  33,  34,  35,
    36,  37,  38,  39,  40,  41,  42,  43,  44,  45,  46,  47,  48,  49,  50,  51,
    52,  53,  54,  55,  56,  57,  58,  60,  62,  64,  66,  68,  70,  72,  74,  76,
    78,  80,  82,  84,  86,  88,  90,  92,  94,  96,  98,  100, 102, 104, 106, 108,
    110, 112, 114, 116, 119, 122, 125, 128, 131, 134, 137, 140, 143, 146, 149, 152,
    155, 158, 161, 164, 167, 170, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209,
    213, 217, 221, 225, 229, 234, 239, 245, 249, 254, 259, 264, 269, 274, 279, 284,
};

const zigzag = [16]u8{ 0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15 };
const coeff_bands = [17]u8{ 0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0 };
const left_context_index = [25]u8{ 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8 };
const above_context_index = [25]u8{ 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 4, 5, 6, 7, 6, 7, 8 };

/// Extra-bit probabilities for DCT_VAL_CATEGORY1..6, most significant bit
/// first (RFC 6386 section 13.2, Pcat1..Pcat6).
const category_probs = [6][]const u8{
    &.{159},
    &.{ 165, 145 },
    &.{ 173, 148, 140 },
    &.{ 176, 155, 140, 135 },
    &.{ 180, 157, 141, 134, 130 },
    &.{ 254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129 },
};
const category_base = [6]i32{ 5, 7, 11, 19, 35, 67 };

const Segmentation = struct {
    enabled: bool = false,
    update_map: bool = false,
    absolute: bool = false,
    quant: [4]i32 = @splat(0),
    filter_level: [4]i32 = @splat(0),
    tree_probs: [3]u8 = @splat(255),
};

const LoopFilter = struct {
    simple: bool = false,
    level: i32 = 0,
    sharpness: i32 = 0,
    delta_enabled: bool = false,
    ref_delta: [4]i32 = @splat(0),
    mode_delta: [4]i32 = @splat(0),
};

/// Dequantization factors per segment: [Y1, UV, Y2][dc, ac].
const Factors = [3][2]i32;

const MacroblockInfo = struct {
    y_mode: u8 = DC_PRED,
    uv_mode: u8 = DC_PRED,
    /// Subblock modes, implied from `y_mode` unless it is B_PRED; used as
    /// context by neighbors.
    b_modes: [16]u8 = @splat(B_DC_PRED),
    segment: u2 = 0,
    skip: bool = false,
    /// Any coefficient decoded for this macroblock.
    has_coefficients: bool = false,
};

const Plane = struct {
    data: []u8,
    stride: usize,
    /// Offset of pixel (0, 0); one border row above and column to the left.
    origin: usize,

    fn at(self: Plane, x: usize, y: usize) usize {
        return self.origin + y * self.stride + x;
    }
};

pub fn decode(alloc: Allocator, data: []const u8, limits: Limits) Error!Raster {
    @setRuntimeSafety(true);
    if (data.len < 10) return error.InvalidImage;
    const tag = @as(u32, data[0]) | (@as(u32, data[1]) << 8) | (@as(u32, data[2]) << 16);
    if (tag & 1 != 0) return error.UnsupportedImage; // inter frame
    if ((tag >> 1) & 7 > 3) return error.UnsupportedImage; // experimental version
    const first_partition_size = tag >> 5;
    if (!std.mem.eql(u8, data[3..6], "\x9d\x01\x2a")) return error.InvalidImage;
    const width: u32 = std.mem.readInt(u16, data[6..8], .little) & 0x3fff;
    const height: u32 = std.mem.readInt(u16, data[8..10], .little) & 0x3fff;
    try limits.check(width, height);
    const payload = data[10..];
    if (first_partition_size > payload.len) return error.InvalidImage;

    var header = BoolDecoder.init(payload[0..first_partition_size]);
    _ = header.uint(2); // color space and clamping type (clamping is always applied)

    var seg: Segmentation = .{};
    seg.enabled = header.bit() == 1;
    if (seg.enabled) {
        seg.update_map = header.bit() == 1;
        const update_data = header.bit() == 1;
        if (update_data) {
            seg.absolute = header.bit() == 1;
            for (&seg.quant) |*q| q.* = header.maybeInt(7);
            for (&seg.filter_level) |*l| l.* = header.maybeInt(6);
        }
        if (seg.update_map) {
            for (&seg.tree_probs) |*p| p.* = if (header.bit() == 1) @intCast(header.uint(8)) else 255;
        }
    }

    var lf: LoopFilter = .{};
    lf.simple = header.bit() == 1;
    lf.level = @intCast(header.uint(6));
    lf.sharpness = @intCast(header.uint(3));
    lf.delta_enabled = header.bit() == 1;
    if (lf.delta_enabled and header.bit() == 1) {
        for (&lf.ref_delta) |*d| d.* = header.maybeInt(6);
        for (&lf.mode_delta) |*d| d.* = header.maybeInt(6);
    }

    const partition_count = @as(usize, 1) << @intCast(header.uint(2));
    var partitions: [8]BoolDecoder = undefined;
    {
        var rest = payload[first_partition_size..];
        const sizes_len = 3 * (partition_count - 1);
        if (rest.len < sizes_len) return error.InvalidImage;
        const sizes = rest[0..sizes_len];
        rest = rest[sizes_len..];
        for (0..partition_count) |i| {
            const size: usize = if (i + 1 < partition_count)
                @as(usize, sizes[i * 3]) | (@as(usize, sizes[i * 3 + 1]) << 8) | (@as(usize, sizes[i * 3 + 2]) << 16)
            else
                rest.len;
            if (size > rest.len) return error.InvalidImage;
            partitions[i] = BoolDecoder.init(rest[0..size]);
            rest = rest[size..];
        }
    }

    const q_index: i32 = @intCast(header.uint(7));
    const y1_dc_delta = header.maybeInt(4);
    const y2_dc_delta = header.maybeInt(4);
    const y2_ac_delta = header.maybeInt(4);
    const uv_dc_delta = header.maybeInt(4);
    const uv_ac_delta = header.maybeInt(4);
    _ = header.bit(); // refresh_entropy_probs: irrelevant for a single frame

    var coeff_probs = tables.default_coeff_probs;
    for (0..4) |i| for (0..8) |j| for (0..3) |k| for (0..11) |l| {
        if (header.get(tables.coeff_update_probs[i][j][k][l]) == 1) coeff_probs[i][j][k][l] = @intCast(header.uint(8));
    };
    const skip_enabled = header.bit() == 1;
    const skip_prob: u8 = if (skip_enabled) @intCast(header.uint(8)) else 0;

    var factors: [4]Factors = undefined;
    for (0..4) |s| {
        var q = q_index;
        if (seg.enabled) q = if (seg.absolute) seg.quant[s] else q + seg.quant[s];
        factors[s] = .{
            .{ dcQ(q + y1_dc_delta), acQ(q) },
            .{ @min(dcQ(q + uv_dc_delta), 132), acQ(q + uv_ac_delta) },
            .{ dcQ(q + y2_dc_delta) * 2, @max(@divTrunc(acQ(q + y2_ac_delta) * 155, 100), 8) },
        };
    }

    const mb_cols = (width + 15) / 16;
    const mb_rows = (height + 15) / 16;
    const y_plane = try allocPlane(alloc, mb_cols * 16, mb_rows * 16, 4);
    defer alloc.free(y_plane.data);
    const u_plane = try allocPlane(alloc, mb_cols * 8, mb_rows * 8, 0);
    defer alloc.free(u_plane.data);
    const v_plane = try allocPlane(alloc, mb_cols * 8, mb_rows * 8, 0);
    defer alloc.free(v_plane.data);

    const infos = try alloc.alloc(MacroblockInfo, @as(usize, mb_cols) * mb_rows);
    defer alloc.free(infos);
    const above_contexts = try alloc.alloc([9]u8, mb_cols);
    defer alloc.free(above_contexts);
    @memset(above_contexts, @splat(0));

    var coefficients: [25 * 16]i16 = undefined;
    var row: usize = 0;
    while (row < mb_rows) : (row += 1) {
        var left_context: [9]u8 = @splat(0);
        const tokens = &partitions[row % partition_count];
        var col: usize = 0;
        while (col < mb_cols) : (col += 1) {
            const info = &infos[row * mb_cols + col];
            info.* = .{};
            if (seg.update_map) info.segment = readSegment(&header, seg.tree_probs);
            if (skip_enabled) info.skip = header.get(skip_prob) == 1;
            const above_info: ?*const MacroblockInfo = if (row > 0) &infos[(row - 1) * mb_cols + col] else null;
            const left_info: ?*const MacroblockInfo = if (col > 0) &infos[row * mb_cols + col - 1] else null;
            readModes(&header, info, above_info, left_info);

            @memset(&coefficients, 0);
            if (info.skip) {
                // Keep the Y2 context unless this macroblock would have coded one.
                @memset(left_context[0..8], 0);
                @memset(above_contexts[col][0..8], 0);
                if (info.y_mode != B_PRED) {
                    left_context[8] = 0;
                    above_contexts[col][8] = 0;
                }
            } else {
                info.has_coefficients = readTokens(tokens, &coefficients, info.y_mode, &coeff_probs, factors[info.segment], &left_context, &above_contexts[col]);
            }
            reconstructMacroblock(y_plane, u_plane, v_plane, info, &coefficients, row, col, mb_cols);
        }
        // Replicate the last pixel of row 15 into the right border so the
        // next row's rightmost macroblock sees above-right pixels.
        const last = y_plane.at(mb_cols * 16 - 1, row * 16 + 15);
        @memset(y_plane.data[last + 1 .. last + 5], y_plane.data[last]);
    }

    if (lf.level != 0) {
        row = 0;
        while (row < mb_rows) : (row += 1) {
            var col: usize = 0;
            while (col < mb_cols) : (col += 1) {
                filterMacroblock(y_plane, u_plane, v_plane, &infos[row * mb_cols + col], row, col, lf, seg);
            }
        }
    }

    var out = try Raster.init(alloc, width, height);
    errdefer out.deinit(alloc);
    yuvToRgb(&out, y_plane, u_plane, v_plane, mb_cols * 8, mb_rows * 8);
    return out;
}

fn dcQ(q: i32) i32 {
    return dc_q_lookup[@intCast(std.math.clamp(q, 0, 127))];
}

fn acQ(q: i32) i32 {
    return ac_q_lookup[@intCast(std.math.clamp(q, 0, 127))];
}

fn allocPlane(alloc: Allocator, width: usize, height: usize, right_border: usize) Error!Plane {
    const stride = width + 1 + right_border;
    const data = try alloc.alloc(u8, stride * (height + 1));
    @memset(data, 0);
    return .{ .data = data, .stride = stride, .origin = stride + 1 };
}

fn readSegment(d: *BoolDecoder, probs: [3]u8) u2 {
    if (d.get(probs[0]) == 1) return @as(u2, 2) + d.get(probs[2]);
    return d.get(probs[1]);
}

fn impliedSubblockMode(y_mode: u8) u8 {
    return switch (y_mode) {
        DC_PRED => B_DC_PRED,
        V_PRED => B_VE_PRED,
        H_PRED => B_HE_PRED,
        TM_PRED => B_TM_PRED,
        else => B_DC_PRED,
    };
}

fn readModes(d: *BoolDecoder, info: *MacroblockInfo, above: ?*const MacroblockInfo, left: ?*const MacroblockInfo) void {
    info.y_mode = d.tree(&kf_y_mode_tree, &kf_y_mode_probs);
    if (info.y_mode == B_PRED) {
        for (0..16) |i| {
            const a: u8 = if (i < 4) (if (above) |m| m.b_modes[i + 12] else B_DC_PRED) else info.b_modes[i - 4];
            const l: u8 = if (i & 3 == 0) (if (left) |m| m.b_modes[i + 3] else B_DC_PRED) else info.b_modes[i - 1];
            info.b_modes[i] = d.tree(&b_mode_tree, &tables.kf_b_mode_probs[a][l]);
        }
    } else {
        @memset(&info.b_modes, impliedSubblockMode(info.y_mode));
    }
    info.uv_mode = d.tree(&uv_mode_tree, &kf_uv_mode_probs);
}

/// Decodes all coefficient tokens of one macroblock (already dequantized).
/// Returns whether any block holds non-zero data.
fn readTokens(
    d: *BoolDecoder,
    coefficients: *[25 * 16]i16,
    y_mode: u8,
    probs: *const [4][8][3][11]u8,
    factors: Factors,
    left: *[9]u8,
    above: *[9]u8,
) bool {
    var any = false;
    var first_y_type: usize = 3;
    var first_y_index: usize = 0;
    if (y_mode != B_PRED) {
        // The Y2 block carries every luma DC.
        const nonzero = readBlock(d, coefficients[24 * 16 ..][0..16], 1, 0, probs, factors[2], left[8] + above[8]);
        left[8] = @intFromBool(nonzero);
        above[8] = @intFromBool(nonzero);
        any = any or nonzero;
        first_y_type = 0;
        first_y_index = 1;
    }
    for (0..24) |i| {
        const block_type: usize = if (i < 16) first_y_type else 2;
        const first: usize = if (i < 16) first_y_index else 0;
        const factor = if (i < 16) factors[0] else factors[1];
        const ctx = left[left_context_index[i]] + above[above_context_index[i]];
        const nonzero = readBlock(d, coefficients[i * 16 ..][0..16], block_type, first, probs, factor, ctx);
        left[left_context_index[i]] = @intFromBool(nonzero);
        above[above_context_index[i]] = @intFromBool(nonzero);
        any = any or nonzero;
    }
    return any;
}

/// Reads one 4x4 block's tokens. `first` is 1 for luma blocks whose DC
/// lives in Y2. Returns whether any coefficient (beyond the skipped DC)
/// was coded.
fn readBlock(
    d: *BoolDecoder,
    block: *[16]i16,
    block_type: usize,
    first: usize,
    probs: *const [4][8][3][11]u8,
    factor: [2]i32,
    context: u8,
) bool {
    var c = first;
    var ctx: usize = context;
    var check_eob = true;
    while (c < 16) {
        const p = &probs[block_type][coeff_bands[c]][ctx];
        if (check_eob and d.get(p[0]) == 0) break;
        if (d.get(p[1]) == 0) {
            // Zero token: the next token cannot be end-of-block.
            ctx = 0;
            check_eob = false;
            c += 1;
            continue;
        }
        check_eob = true;
        var value: i32 = undefined;
        if (d.get(p[2]) == 0) {
            value = 1;
            ctx = 1;
        } else {
            ctx = 2;
            if (d.get(p[3]) == 0) {
                if (d.get(p[4]) == 0) {
                    value = 2;
                } else {
                    value = 3 + @as(i32, d.get(p[5]));
                }
            } else if (d.get(p[6]) == 0) {
                if (d.get(p[7]) == 0) {
                    value = category_base[0] + extraBits(d, 0);
                } else {
                    value = category_base[1] + extraBits(d, 1);
                }
            } else if (d.get(p[8]) == 0) {
                value = if (d.get(p[9]) == 0) category_base[2] + extraBits(d, 2) else category_base[3] + extraBits(d, 3);
            } else {
                value = if (d.get(p[10]) == 0) category_base[4] + extraBits(d, 4) else category_base[5] + extraBits(d, 5);
            }
        }
        if (d.bit() == 1) value = -value;
        const q = if (c > 0) factor[1] else factor[0];
        block[zigzag[c]] = @intCast(std.math.clamp(value * q, std.math.minInt(i16), std.math.maxInt(i16)));
        c += 1;
    }
    return c != first;
}

fn extraBits(d: *BoolDecoder, category: usize) i32 {
    var value: i32 = 0;
    for (category_probs[category]) |p| value = (value << 1) | d.get(p);
    return value;
}

fn walsh(input: *const [16]i16, output: *[16]i16) void {
    var tmp: [16]i32 = undefined;
    for (0..4) |i| {
        const a1 = @as(i32, input[i]) + input[12 + i];
        const b1 = @as(i32, input[4 + i]) + input[8 + i];
        const c1 = @as(i32, input[4 + i]) - input[8 + i];
        const d1 = @as(i32, input[i]) - input[12 + i];
        tmp[i] = a1 + b1;
        tmp[4 + i] = c1 + d1;
        tmp[8 + i] = a1 - b1;
        tmp[12 + i] = d1 - c1;
    }
    for (0..4) |i| {
        const a1 = tmp[i * 4] + tmp[i * 4 + 3];
        const b1 = tmp[i * 4 + 1] + tmp[i * 4 + 2];
        const c1 = tmp[i * 4 + 1] - tmp[i * 4 + 2];
        const d1 = tmp[i * 4] - tmp[i * 4 + 3];
        output[i * 4] = clampI16((a1 + b1 + 3) >> 3);
        output[i * 4 + 1] = clampI16((c1 + d1 + 3) >> 3);
        output[i * 4 + 2] = clampI16((a1 - b1 + 3) >> 3);
        output[i * 4 + 3] = clampI16((d1 - c1 + 3) >> 3);
    }
}

fn clampI16(v: i32) i16 {
    return @intCast(std.math.clamp(v, std.math.minInt(i16), std.math.maxInt(i16)));
}

const cospi8sqrt2minus1: i64 = 20091;
const sinpi8sqrt2: i64 = 35468;

/// Inverse DCT of `coeffs` added onto the 4x4 prediction at `at`. Uses
/// 64-bit intermediates: hostile coefficients would overflow 32 bits.
fn idctAdd(plane: []u8, at: usize, stride: usize, coeffs: *const [16]i16) void {
    var tmp: [16]i64 = undefined;
    for (0..4) |i| {
        const ip0: i64 = coeffs[i];
        const ip4: i64 = coeffs[4 + i];
        const ip8: i64 = coeffs[8 + i];
        const ip12: i64 = coeffs[12 + i];
        const a1 = ip0 + ip8;
        const b1 = ip0 - ip8;
        var temp1 = (ip4 * sinpi8sqrt2) >> 16;
        var temp2 = ip12 + ((ip12 * cospi8sqrt2minus1) >> 16);
        const c1 = temp1 - temp2;
        temp1 = ip4 + ((ip4 * cospi8sqrt2minus1) >> 16);
        temp2 = (ip12 * sinpi8sqrt2) >> 16;
        const d1 = temp1 + temp2;
        tmp[i] = a1 + d1;
        tmp[12 + i] = a1 - d1;
        tmp[4 + i] = b1 + c1;
        tmp[8 + i] = b1 - c1;
    }
    for (0..4) |i| {
        const row = tmp[i * 4 ..][0..4];
        const a1 = row[0] + row[2];
        const b1 = row[0] - row[2];
        var temp1 = (row[1] * sinpi8sqrt2) >> 16;
        var temp2 = row[3] + ((row[3] * cospi8sqrt2minus1) >> 16);
        const c1 = temp1 - temp2;
        temp1 = row[1] + ((row[1] * cospi8sqrt2minus1) >> 16);
        temp2 = (row[3] * sinpi8sqrt2) >> 16;
        const d1 = temp1 + temp2;
        const base = at + i * stride;
        plane[base] = clampAdd(plane[base], (a1 + d1 + 4) >> 3);
        plane[base + 3] = clampAdd(plane[base + 3], (a1 - d1 + 4) >> 3);
        plane[base + 1] = clampAdd(plane[base + 1], (b1 + c1 + 4) >> 3);
        plane[base + 2] = clampAdd(plane[base + 2], (b1 - c1 + 4) >> 3);
    }
}

fn clampAdd(pixel: u8, residual: i64) u8 {
    return @intCast(std.math.clamp(@as(i64, pixel) + residual, 0, 255));
}

fn clamp255(v: i32) u8 {
    return @intCast(std.math.clamp(v, 0, 255));
}

fn reconstructMacroblock(
    y: Plane,
    u: Plane,
    v: Plane,
    info: *const MacroblockInfo,
    coefficients: *[25 * 16]i16,
    row: usize,
    col: usize,
    mb_cols: usize,
) void {
    @setRuntimeSafety(true);
    _ = mb_cols;
    const y_at = y.at(col * 16, row * 16);
    const u_at = u.at(col * 8, row * 8);
    const v_at = v.at(col * 8, row * 8);
    if (col == 0) {
        fixupLeft(y.data, y_at, y.stride, 16, row, info.y_mode);
        fixupLeft(u.data, u_at, u.stride, 8, row, info.uv_mode);
        fixupLeft(v.data, v_at, v.stride, 8, row, info.uv_mode);
        if (row == 0) y.data[y_at - y.stride - 1] = 127;
    }
    if (row == 0) {
        fixupAbove(y.data, y_at, y.stride, 16, col, info.y_mode, true);
        fixupAbove(u.data, u_at, u.stride, 8, col, info.uv_mode, false);
        fixupAbove(v.data, v_at, v.stride, 8, col, info.uv_mode, false);
    }

    if (info.y_mode == B_PRED) {
        // Above-right pixels of subblock 3 serve subblocks 7, 11 and 15.
        const above_right = y_at - y.stride + 16;
        for ([_]usize{ 4, 8, 12 }) |r| {
            @memcpy(y.data[above_right + r * y.stride ..][0..4], y.data[above_right..][0..4]);
        }
        for (0..16) |i| {
            const at = y_at + (i >> 2) * 4 * y.stride + (i & 3) * 4;
            predictSubblock(y.data, at, y.stride, info.b_modes[i]);
            idctAdd(y.data, at, y.stride, coefficients[i * 16 ..][0..16]);
        }
    } else {
        predictBlock(y.data, y_at, y.stride, 16, info.y_mode);
        var dc: [16]i16 = undefined;
        walsh(coefficients[24 * 16 ..][0..16], &dc);
        for (0..16) |i| {
            coefficients[i * 16] = dc[i];
            const at = y_at + (i >> 2) * 4 * y.stride + (i & 3) * 4;
            idctAdd(y.data, at, y.stride, coefficients[i * 16 ..][0..16]);
        }
    }

    predictBlock(u.data, u_at, u.stride, 8, info.uv_mode);
    predictBlock(v.data, v_at, v.stride, 8, info.uv_mode);
    for (0..4) |i| {
        const offset = (i >> 1) * 4 * u.stride + (i & 1) * 4;
        idctAdd(u.data, u_at + offset, u.stride, coefficients[(16 + i) * 16 ..][0..16]);
        idctAdd(v.data, v_at + offset, v.stride, coefficients[(20 + i) * 16 ..][0..16]);
    }
}

/// Out-of-frame left pixels are 129, except that DC prediction below the
/// first row reuses the above row (so it averages only real pixels).
fn fixupLeft(plane: []u8, at: usize, stride: usize, n: usize, row: usize, mode: u8) void {
    if (mode == DC_PRED and row > 0) {
        for (0..n) |i| plane[at - 1 + i * stride] = plane[at - stride + i];
    } else {
        var i: usize = 0;
        while (i <= n) : (i += 1) plane[at - 1 - stride + i * stride] = 129;
    }
}

/// Out-of-frame above pixels are 127, except that DC prediction right of
/// the first column reuses the left column.
fn fixupAbove(plane: []u8, at: usize, stride: usize, n: usize, col: usize, mode: u8, above_right: bool) void {
    const above = at - stride;
    if (mode == DC_PRED and col > 0) {
        for (0..n) |i| plane[above + i] = plane[at - 1 + i * stride];
    } else {
        @memset(plane[above - 1 .. above + n], 127);
    }
    if (above_right) @memset(plane[above + n .. above + n + 4], 127);
}

fn predictBlock(plane: []u8, at: usize, stride: usize, n: usize, mode: u8) void {
    const above = at - stride;
    switch (mode) {
        DC_PRED => {
            var sum: u32 = 0;
            for (0..n) |i| sum += @as(u32, plane[at - 1 + i * stride]) + plane[above + i];
            const shift: u5 = if (n == 16) 5 else if (n == 8) 4 else 3;
            const dc: u8 = @intCast((sum + @as(u32, @intCast(n))) >> shift);
            for (0..n) |r| @memset(plane[at + r * stride ..][0..n], dc);
        },
        V_PRED => for (0..n) |r| @memcpy(plane[at + r * stride ..][0..n], plane[above..][0..n]),
        H_PRED => for (0..n) |r| @memset(plane[at + r * stride ..][0..n], plane[at - 1 + r * stride]),
        TM_PRED => {
            const corner: i32 = plane[above - 1];
            for (0..n) |r| {
                const left: i32 = plane[at - 1 + r * stride];
                for (0..n) |c| plane[at + r * stride + c] = clamp255(left + plane[above + c] - corner);
            }
        },
        else => unreachable,
    }
}

fn predictSubblock(plane: []u8, at: usize, stride: usize, mode: u8) void {
    const top = at - stride;
    // E[0..8]: above-left, above[0..3], above-right[0..3]
    var above: [9]i32 = undefined;
    above[0] = plane[top - 1];
    for (0..8) |i| above[i + 1] = plane[top + i];
    var left: [4]i32 = undefined;
    for (0..4) |i| left[i] = plane[at - 1 + i * stride];
    const tl = above[0];
    const a = above[1..];
    var out: [4][4]i32 = undefined;
    switch (mode) {
        B_DC_PRED => {
            var sum: i32 = 4;
            for (0..4) |i| sum += a[i] + left[i];
            out = @splat(@splat(sum >> 3));
        },
        B_TM_PRED => for (0..4) |r| for (0..4) |c| {
            out[r][c] = std.math.clamp(left[r] + a[c] - tl, 0, 255);
        },
        B_VE_PRED => for (0..4) |c| {
            const value = (above[c] + 2 * above[c + 1] + above[c + 2] + 2) >> 2;
            for (0..4) |r| out[r][c] = value;
        },
        B_HE_PRED => {
            const rows = [4]i32{
                (tl + 2 * left[0] + left[1] + 2) >> 2,
                (left[0] + 2 * left[1] + left[2] + 2) >> 2,
                (left[1] + 2 * left[2] + left[3] + 2) >> 2,
                (left[2] + 2 * left[3] + left[3] + 2) >> 2,
            };
            for (0..4) |r| out[r] = @splat(rows[r]);
        },
        B_LD_PRED => for (0..4) |r| for (0..4) |c| {
            const i = r + c;
            out[r][c] = if (i < 6) (a[i] + 2 * a[i + 1] + a[i + 2] + 2) >> 2 else (a[6] + 3 * a[7] + 2) >> 2;
        },
        B_RD_PRED => {
            // Edge from bottom-left up to above-right: L3 L2 L1 L0 TL A0..A3
            const e = [9]i32{ left[3], left[2], left[1], left[0], tl, a[0], a[1], a[2], a[3] };
            for (0..4) |r| for (0..4) |c| {
                const i = 3 - r + c;
                out[r][c] = (e[i] + 2 * e[i + 1] + e[i + 2] + 2) >> 2;
            };
        },
        B_VR_PRED => {
            out[0] = .{ avg2(tl, a[0]), avg2(a[0], a[1]), avg2(a[1], a[2]), avg2(a[2], a[3]) };
            out[1] = .{ avg3(left[0], tl, a[0]), avg3(tl, a[0], a[1]), avg3(a[0], a[1], a[2]), avg3(a[1], a[2], a[3]) };
            out[2] = .{ avg3(left[1], left[0], tl), out[0][0], out[0][1], out[0][2] };
            out[3] = .{ avg3(left[2], left[1], left[0]), out[1][0], out[1][1], out[1][2] };
        },
        B_VL_PRED => {
            out[0] = .{ avg2(a[0], a[1]), avg2(a[1], a[2]), avg2(a[2], a[3]), avg2(a[3], a[4]) };
            out[1] = .{ avg3(a[0], a[1], a[2]), avg3(a[1], a[2], a[3]), avg3(a[2], a[3], a[4]), avg3(a[3], a[4], a[5]) };
            out[2] = .{ out[0][1], out[0][2], out[0][3], avg3(a[4], a[5], a[6]) };
            out[3] = .{ out[1][1], out[1][2], out[1][3], avg3(a[5], a[6], a[7]) };
        },
        B_HD_PRED => {
            out[0] = .{ avg2(left[0], tl), avg3(left[0], tl, a[0]), avg3(tl, a[0], a[1]), avg3(a[0], a[1], a[2]) };
            out[1] = .{ avg2(left[1], left[0]), avg3(left[1], left[0], tl), out[0][0], out[0][1] };
            out[2] = .{ avg2(left[2], left[1]), avg3(left[2], left[1], left[0]), out[1][0], out[1][1] };
            out[3] = .{ avg2(left[3], left[2]), avg3(left[3], left[2], left[1]), out[2][0], out[2][1] };
        },
        B_HU_PRED => {
            out[0] = .{ avg2(left[0], left[1]), avg3(left[0], left[1], left[2]), avg2(left[1], left[2]), avg3(left[1], left[2], left[3]) };
            out[1] = .{ out[0][2], out[0][3], avg2(left[2], left[3]), avg3(left[2], left[3], left[3]) };
            out[2] = .{ out[1][2], out[1][3], left[3], left[3] };
            out[3] = @splat(left[3]);
        },
        else => unreachable,
    }
    for (0..4) |r| for (0..4) |c| {
        plane[at + r * stride + c] = @intCast(out[r][c]);
    };
}

fn avg2(x: i32, y: i32) i32 {
    return (x + y + 1) >> 1;
}

fn avg3(x: i32, y: i32, z: i32) i32 {
    return (x + 2 * y + z + 2) >> 2;
}

// ---------------------------------------------------------------------------
// Loop filter

const FilterParams = struct {
    edge_limit: i32,
    interior_limit: i32,
    hev_threshold: i32,
};

fn filterParams(info: *const MacroblockInfo, lf: LoopFilter, seg: Segmentation) FilterParams {
    var level = lf.level;
    if (seg.enabled) {
        level = if (seg.absolute) seg.filter_level[info.segment] else level + seg.filter_level[info.segment];
    }
    level = std.math.clamp(level, 0, 63);
    if (lf.delta_enabled) {
        level += lf.ref_delta[0]; // intra frame
        if (info.y_mode == B_PRED) level += lf.mode_delta[0];
    }
    level = std.math.clamp(level, 0, 63);
    var interior = level;
    if (lf.sharpness != 0) {
        interior >>= if (lf.sharpness > 4) 2 else 1;
        interior = @min(interior, 9 - lf.sharpness);
    }
    interior = @max(interior, 1);
    var hev: i32 = 0;
    if (level >= 15) hev += 1;
    if (level >= 40) hev += 1;
    return .{ .edge_limit = level, .interior_limit = interior, .hev_threshold = hev };
}

fn s8(x: i32) i32 {
    return std.math.clamp(x, -128, 127);
}

/// Pixel access along the filter axis: p3..p0 before the edge, q0..q3 after.
const Taps = struct {
    plane: []u8,
    at: usize,
    step: usize,

    fn get(self: Taps, k: i32) i32 {
        const index: isize = @as(isize, @intCast(self.at)) + k * @as(isize, @intCast(self.step));
        return self.plane[@intCast(index)];
    }

    fn set(self: Taps, k: i32, value: i32) void {
        const index: isize = @as(isize, @intCast(self.at)) + k * @as(isize, @intCast(self.step));
        self.plane[@intCast(index)] = clamp255(value);
    }
};

fn simpleThreshold(t: Taps, limit: i32) bool {
    return @as(i32, @intCast(@abs(t.get(-1) - t.get(0)))) * 2 + (@as(i32, @intCast(@abs(t.get(-2) - t.get(1)))) >> 1) <= limit;
}

fn normalThreshold(t: Taps, edge: i32, interior: i32) bool {
    if (!simpleThreshold(t, 2 * edge + interior)) return false;
    const pairs = [_][2]i32{ .{ -4, -3 }, .{ -3, -2 }, .{ -2, -1 }, .{ 3, 2 }, .{ 2, 1 }, .{ 1, 0 } };
    for (pairs) |pair| {
        if (@abs(t.get(pair[0]) - t.get(pair[1])) > interior) return false;
    }
    return true;
}

fn highEdgeVariance(t: Taps, threshold: i32) bool {
    return @abs(t.get(-2) - t.get(-1)) > threshold or @abs(t.get(1) - t.get(0)) > threshold;
}

fn filterCommon(t: Taps, use_outer_taps: bool) void {
    const p1 = t.get(-2);
    const p0 = t.get(-1);
    const q0 = t.get(0);
    const q1 = t.get(1);
    var a = 3 * (q0 - p0);
    if (use_outer_taps) a += s8(p1 - q1);
    a = s8(a);
    const f1 = @min(a + 4, 127) >> 3;
    const f2 = @min(a + 3, 127) >> 3;
    t.set(-1, p0 + f2);
    t.set(0, q0 - f1);
    if (!use_outer_taps) {
        const adjust = (f1 + 1) >> 1;
        t.set(-2, p1 + adjust);
        t.set(1, q1 - adjust);
    }
}

fn filterMbEdge(t: Taps) void {
    const p2 = t.get(-3);
    const p1 = t.get(-2);
    const p0 = t.get(-1);
    const q0 = t.get(0);
    const q1 = t.get(1);
    const q2 = t.get(2);
    const w = s8(s8(p1 - q1) + 3 * (q0 - p0));
    var a = (27 * w + 63) >> 7;
    t.set(-1, p0 + a);
    t.set(0, q0 - a);
    a = (18 * w + 63) >> 7;
    t.set(-2, p1 + a);
    t.set(1, q1 - a);
    a = (9 * w + 63) >> 7;
    t.set(-3, p2 + a);
    t.set(2, q2 - a);
}

/// Filters `count` positions of one edge. `step` crosses the edge;
/// `advance` moves along it.
fn filterEdge(plane: []u8, start: usize, step: usize, advance: usize, count: usize, macroblock_edge: bool, p: FilterParams, simple: bool) void {
    for (0..count) |i| {
        const t = Taps{ .plane = plane, .at = start + i * advance, .step = step };
        if (simple) {
            const limit = if (macroblock_edge) (p.edge_limit + 2) * 2 + p.interior_limit else p.edge_limit * 2 + p.interior_limit;
            if (simpleThreshold(t, limit)) filterCommon(t, true);
            continue;
        }
        const edge = if (macroblock_edge) p.edge_limit + 2 else p.edge_limit;
        if (!normalThreshold(t, edge, p.interior_limit)) continue;
        const hev = highEdgeVariance(t, p.hev_threshold);
        if (macroblock_edge) {
            if (hev) filterCommon(t, true) else filterMbEdge(t);
        } else {
            filterCommon(t, hev);
        }
    }
}

fn filterMacroblock(y: Plane, u: Plane, v: Plane, info: *const MacroblockInfo, row: usize, col: usize, lf: LoopFilter, seg: Segmentation) void {
    @setRuntimeSafety(true);
    const p = filterParams(info, lf, seg);
    if (p.edge_limit == 0) return;
    const inner = info.has_coefficients or info.y_mode == B_PRED;
    const y_at = y.at(col * 16, row * 16);
    const u_at = u.at(col * 8, row * 8);
    const v_at = v.at(col * 8, row * 8);
    const planes = [_]struct { plane: Plane, at: usize, size: usize, luma: bool }{
        .{ .plane = y, .at = y_at, .size = 16, .luma = true },
        .{ .plane = u, .at = u_at, .size = 8, .luma = false },
        .{ .plane = v, .at = v_at, .size = 8, .luma = false },
    };
    // Order per macroblock: left edge, inner vertical edges, top edge,
    // inner horizontal edges; the simple filter touches luma only.
    for (planes) |pl| {
        if (lf.simple and !pl.luma) continue;
        if (col > 0) filterEdge(pl.plane.data, pl.at, 1, pl.plane.stride, pl.size, true, p, lf.simple);
    }
    if (inner) for (planes) |pl| {
        if (lf.simple and !pl.luma) continue;
        var x: usize = 4;
        while (x < pl.size) : (x += 4) filterEdge(pl.plane.data, pl.at + x, 1, pl.plane.stride, pl.size, false, p, lf.simple);
    };
    for (planes) |pl| {
        if (lf.simple and !pl.luma) continue;
        if (row > 0) filterEdge(pl.plane.data, pl.at, pl.plane.stride, 1, pl.size, true, p, lf.simple);
    }
    if (inner) for (planes) |pl| {
        if (lf.simple and !pl.luma) continue;
        var yy: usize = 4;
        while (yy < pl.size) : (yy += 4) filterEdge(pl.plane.data, pl.at + yy * pl.plane.stride, pl.plane.stride, 1, pl.size, false, p, lf.simple);
    };
}

// ---------------------------------------------------------------------------
// Color conversion (BT.601 limited range, as libwebp), bilinear chroma.

fn yuvToRgb(out: *Raster, y: Plane, u: Plane, v: Plane, chroma_w: usize, chroma_h: usize) void {
    const valid_cw = @max(1, (out.width + 1) / 2);
    const valid_ch = @max(1, (out.height + 1) / 2);
    _ = chroma_w;
    _ = chroma_h;
    var py: u32 = 0;
    while (py < out.height) : (py += 1) {
        const fy = @max(0.0, (@as(f32, @floatFromInt(py)) + 0.5) * 0.5 - 0.5);
        const y0: usize = @min(@as(usize, @intFromFloat(fy)), valid_ch - 1);
        const y1 = @min(y0 + 1, valid_ch - 1);
        const ty = fy - @floor(fy);
        var px: u32 = 0;
        while (px < out.width) : (px += 1) {
            const fx = @max(0.0, (@as(f32, @floatFromInt(px)) + 0.5) * 0.5 - 0.5);
            const x0: usize = @min(@as(usize, @intFromFloat(fx)), valid_cw - 1);
            const x1 = @min(x0 + 1, valid_cw - 1);
            const tx = fx - @floor(fx);
            const cu = bilinear(u, x0, x1, y0, y1, tx, ty);
            const cv = bilinear(v, x0, x1, y0, y1, tx, ty);
            const luma: i32 = y.data[y.at(px, py)];
            const yy = (luma * 19077) >> 8;
            out.pixel(px, py).* = .{
                clip8(yy + ((cv * 26149) >> 8) - 14234),
                clip8(yy - ((cu * 6419) >> 8) - ((cv * 13320) >> 8) + 8708),
                clip8(yy + ((cu * 33050) >> 8) - 17685),
                255,
            };
        }
    }
}

fn bilinear(plane: Plane, x0: usize, x1: usize, y0: usize, y1: usize, tx: f32, ty: f32) i32 {
    const a = @as(f32, @floatFromInt(plane.data[plane.at(x0, y0)]));
    const b = @as(f32, @floatFromInt(plane.data[plane.at(x1, y0)]));
    const c = @as(f32, @floatFromInt(plane.data[plane.at(x0, y1)]));
    const d = @as(f32, @floatFromInt(plane.data[plane.at(x1, y1)]));
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return @intFromFloat(@round(top + (bottom - top) * ty));
}

/// Values carry 6 fractional bits.
fn clip8(v: i32) u8 {
    if (v < 0) return 0;
    if (v >= 256 << 6) return 255;
    return @intCast(v >> 6);
}

test "bool decoder reads literal bits written at probability one half" {
    // 0x00 0x00 decodes to zeros at any probability.
    var d = BoolDecoder.init("\x00\x00\x00\x00");
    try std.testing.expectEqual(@as(u32, 0), d.uint(8));
}

test "walsh inverse of a DC-only block spreads evenly" {
    var input: [16]i16 = @splat(0);
    input[0] = 80;
    var out: [16]i16 = undefined;
    walsh(&input, &out);
    for (out) |value| try std.testing.expectEqual(@as(i16, 10), value);
}

test "tables have the reference shapes and anchor values" {
    try std.testing.expectEqual(@as(u8, 253), tables.default_coeff_probs[0][1][0][0]);
    try std.testing.expectEqual(@as(u8, 231), tables.kf_b_mode_probs[0][0][0]);
    try std.testing.expectEqual(@as(u8, 255), tables.coeff_update_probs[0][0][0][0]);
}

test "rejects inter frames and bad start codes" {
    const alloc = std.testing.allocator;
    try std.testing.expectError(error.UnsupportedImage, decode(alloc, "\x01\x00\x00\x9d\x01\x2a\x01\x00\x01\x00", .default));
    try std.testing.expectError(error.InvalidImage, decode(alloc, "\x00\x00\x00\x00\x00\x00\x01\x00\x01\x00", .default));
}

test "inverse DCT handles extreme coefficients without overflowing" {
    for ([_]i16{ std.math.minInt(i16), std.math.maxInt(i16) }) |value| {
        var plane: [16]u8 = @splat(128);
        const coefficients: [16]i16 = @splat(value);
        idctAdd(&plane, 0, 4, &coefficients);
        try std.testing.expect(plane[0] != 128);
    }
}
