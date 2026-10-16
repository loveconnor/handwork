//! PNG decoding (RFC 2083 / ISO 15948) and a minimal RGBA8 encoder.
//!
//! The decoder treats the file as untrusted: chunk lengths, CRCs, header
//! fields, and the inflated byte count are all checked before use, and
//! runtime safety stays on in release builds so any missed bound panics
//! instead of reading out of range.

const std = @import("std");
const raster_mod = @import("../raster.zig");
const inflate = @import("inflate.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;
const Limits = raster_mod.Limits;

pub const signature = "\x89PNG\r\n\x1a\n";

pub const Error = Allocator.Error || error{ InvalidImage, ImageTooLarge, UnsupportedImage };

const Header = struct {
    width: u32,
    height: u32,
    bit_depth: u8,
    color_type: u8,
    interlaced: bool,

    fn channels(self: Header) u8 {
        return switch (self.color_type) {
            0 => 1,
            2 => 3,
            3 => 1,
            4 => 2,
            6 => 4,
            else => unreachable,
        };
    }

    fn bitsPerPixel(self: Header) u32 {
        return @as(u32, self.channels()) * self.bit_depth;
    }

    fn rowBytes(self: Header, width: u32) usize {
        return (@as(usize, width) * self.bitsPerPixel() + 7) / 8;
    }
};

const Transparency = union(enum) {
    none,
    gray: u16,
    rgb: [3]u16,
};

pub fn isPng(bytes: []const u8) bool {
    return bytes.len >= signature.len and std.mem.eql(u8, bytes[0..signature.len], signature);
}

/// Reads only the IHDR dimensions; used for layout before full decode.
pub fn dimensions(bytes: []const u8) Error!struct { width: u32, height: u32 } {
    if (!isPng(bytes) or bytes.len < 33) return error.InvalidImage;
    if (!std.mem.eql(u8, bytes[12..16], "IHDR")) return error.InvalidImage;
    return .{
        .width = std.mem.readInt(u32, bytes[16..20], .big),
        .height = std.mem.readInt(u32, bytes[20..24], .big),
    };
}

pub fn decode(alloc: Allocator, bytes: []const u8, limits: Limits) Error!Raster {
    @setRuntimeSafety(true);
    if (!isPng(bytes)) return error.InvalidImage;

    var header: ?Header = null;
    var palette: [256][4]u8 = undefined;
    var palette_len: usize = 0;
    var transparency: Transparency = .none;
    var compressed: std.ArrayList(u8) = .empty;
    defer compressed.deinit(alloc);
    var saw_end = false;

    var pos: usize = signature.len;
    while (pos + 12 <= bytes.len) {
        const length = std.mem.readInt(u32, bytes[pos..][0..4], .big);
        if (length > bytes.len - pos - 12) return error.InvalidImage;
        const kind = bytes[pos + 4 .. pos + 8];
        const data = bytes[pos + 8 .. pos + 8 + length];
        const stored_crc = std.mem.readInt(u32, bytes[pos + 8 + length ..][0..4], .big);
        var crc = std.hash.Crc32.init();
        crc.update(kind);
        crc.update(data);
        if (crc.final() != stored_crc) return error.InvalidImage;
        pos += 12 + length;

        if (std.mem.eql(u8, kind, "IHDR")) {
            if (header != null or data.len != 13) return error.InvalidImage;
            header = try parseHeader(data, limits);
        } else if (std.mem.eql(u8, kind, "PLTE")) {
            if (data.len % 3 != 0 or data.len / 3 > 256 or data.len == 0) return error.InvalidImage;
            palette_len = data.len / 3;
            for (0..palette_len) |i| palette[i] = .{ data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255 };
        } else if (std.mem.eql(u8, kind, "tRNS")) {
            const h = header orelse return error.InvalidImage;
            switch (h.color_type) {
                3 => {
                    if (data.len > palette_len) return error.InvalidImage;
                    for (data, 0..) |alpha, i| palette[i][3] = alpha;
                },
                0 => {
                    if (data.len < 2) return error.InvalidImage;
                    transparency = .{ .gray = std.mem.readInt(u16, data[0..2], .big) };
                },
                2 => {
                    if (data.len < 6) return error.InvalidImage;
                    transparency = .{ .rgb = .{
                        std.mem.readInt(u16, data[0..2], .big),
                        std.mem.readInt(u16, data[2..4], .big),
                        std.mem.readInt(u16, data[4..6], .big),
                    } };
                },
                else => {},
            }
        } else if (std.mem.eql(u8, kind, "IDAT")) {
            if (header == null) return error.InvalidImage;
            try compressed.appendSlice(alloc, data);
        } else if (std.mem.eql(u8, kind, "IEND")) {
            saw_end = true;
            break;
        } else if (kind[0] & 0x20 == 0) {
            // An unknown critical chunk changes how pixels must be read.
            return error.UnsupportedImage;
        }
    }
    const h = header orelse return error.InvalidImage;
    if (!saw_end or compressed.items.len == 0) return error.InvalidImage;
    if (h.color_type == 3 and palette_len == 0) return error.InvalidImage;

    const expected = expectedInflatedLen(h);
    const inflated = try inflate.zlibDecompress(alloc, compressed.items, expected);
    defer alloc.free(inflated);

    var out = try Raster.init(alloc, h.width, h.height);
    errdefer out.deinit(alloc);
    const ctx = PixelContext{ .header = h, .palette = palette[0..palette_len], .transparency = transparency };
    if (h.interlaced) {
        try decodeInterlaced(alloc, ctx, inflated, &out);
    } else {
        try decodePass(alloc, ctx, inflated, &out, .{ .x0 = 0, .y0 = 0, .dx = 1, .dy = 1 });
    }
    return out;
}

fn parseHeader(data: []const u8, limits: Limits) Error!Header {
    const width = std.mem.readInt(u32, data[0..4], .big);
    const height = std.mem.readInt(u32, data[4..8], .big);
    limits.check(width, height) catch |err| return err;
    const bit_depth = data[8];
    const color_type = data[9];
    const valid_depth = switch (color_type) {
        0 => bit_depth == 1 or bit_depth == 2 or bit_depth == 4 or bit_depth == 8 or bit_depth == 16,
        3 => bit_depth == 1 or bit_depth == 2 or bit_depth == 4 or bit_depth == 8,
        2, 4, 6 => bit_depth == 8 or bit_depth == 16,
        else => false,
    };
    if (!valid_depth) return error.InvalidImage;
    if (data[10] != 0 or data[11] != 0 or data[12] > 1) return error.InvalidImage;
    return .{
        .width = width,
        .height = height,
        .bit_depth = bit_depth,
        .color_type = color_type,
        .interlaced = data[12] == 1,
    };
}

const Pass = struct { x0: u32, y0: u32, dx: u32, dy: u32 };

const adam7 = [_]Pass{
    .{ .x0 = 0, .y0 = 0, .dx = 8, .dy = 8 },
    .{ .x0 = 4, .y0 = 0, .dx = 8, .dy = 8 },
    .{ .x0 = 0, .y0 = 4, .dx = 4, .dy = 8 },
    .{ .x0 = 2, .y0 = 0, .dx = 4, .dy = 4 },
    .{ .x0 = 0, .y0 = 2, .dx = 2, .dy = 4 },
    .{ .x0 = 1, .y0 = 0, .dx = 2, .dy = 2 },
    .{ .x0 = 0, .y0 = 1, .dx = 1, .dy = 2 },
};

fn passSize(pass: Pass, width: u32, height: u32) struct { w: u32, h: u32 } {
    const w = if (width > pass.x0) (width - pass.x0 + pass.dx - 1) / pass.dx else 0;
    const h = if (height > pass.y0) (height - pass.y0 + pass.dy - 1) / pass.dy else 0;
    return .{ .w = w, .h = h };
}

fn expectedInflatedLen(h: Header) usize {
    if (!h.interlaced) return (h.rowBytes(h.width) + 1) * h.height;
    var total: usize = 0;
    for (adam7) |pass| {
        const size = passSize(pass, h.width, h.height);
        if (size.w == 0 or size.h == 0) continue;
        total += (h.rowBytes(size.w) + 1) * size.h;
    }
    return total;
}

const PixelContext = struct {
    header: Header,
    palette: []const [4]u8,
    transparency: Transparency,
};

fn decodeInterlaced(alloc: Allocator, ctx: PixelContext, data: []const u8, out: *Raster) Error!void {
    var offset: usize = 0;
    for (adam7) |pass| {
        const size = passSize(pass, ctx.header.width, ctx.header.height);
        if (size.w == 0 or size.h == 0) continue;
        const len = (ctx.header.rowBytes(size.w) + 1) * size.h;
        if (offset + len > data.len) return error.InvalidImage;
        try decodePass(alloc, ctx, data[offset .. offset + len], out, pass);
        offset += len;
    }
}

fn decodePass(alloc: Allocator, ctx: PixelContext, data: []const u8, out: *Raster, pass: Pass) Error!void {
    @setRuntimeSafety(true);
    const h = ctx.header;
    const size = passSize(pass, h.width, h.height);
    const row_bytes = h.rowBytes(size.w);
    const bpp: usize = @max(1, h.bitsPerPixel() / 8);
    const previous = try alloc.alloc(u8, row_bytes);
    defer alloc.free(previous);
    const current = try alloc.alloc(u8, row_bytes);
    defer alloc.free(current);
    @memset(previous, 0);

    var y: u32 = 0;
    while (y < size.h) : (y += 1) {
        const start = @as(usize, y) * (row_bytes + 1);
        if (start + row_bytes + 1 > data.len) return error.InvalidImage;
        const filter = data[start];
        @memcpy(current, data[start + 1 .. start + 1 + row_bytes]);
        try unfilter(filter, current, previous, bpp);

        var x: u32 = 0;
        while (x < size.w) : (x += 1) {
            const dest = out.pixel(pass.x0 + x * pass.dx, pass.y0 + y * pass.dy);
            dest.* = samplePixel(ctx, current, x);
        }
        @memcpy(previous, current);
    }
}

fn unfilter(filter: u8, current: []u8, previous: []const u8, bpp: usize) Error!void {
    @setRuntimeSafety(true);
    switch (filter) {
        0 => {},
        1 => for (bpp..current.len) |i| {
            current[i] +%= current[i - bpp];
        },
        2 => for (current, previous) |*c, p| {
            c.* +%= p;
        },
        3 => for (current, 0..) |*c, i| {
            const left: u16 = if (i >= bpp) current[i - bpp] else 0;
            c.* +%= @intCast((left + previous[i]) / 2);
        },
        4 => for (current, 0..) |*c, i| {
            const left: u8 = if (i >= bpp) current[i - bpp] else 0;
            const upper_left: u8 = if (i >= bpp) previous[i - bpp] else 0;
            c.* +%= paeth(left, previous[i], upper_left);
        },
        else => return error.InvalidImage,
    }
}

fn paeth(a: u8, b: u8, c: u8) u8 {
    const p = @as(i16, a) + b - c;
    const pa = @abs(p - a);
    const pb = @abs(p - b);
    const pc = @abs(p - c);
    if (pa <= pb and pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

fn sample(row: []const u8, depth: u8, index: usize) u16 {
    @setRuntimeSafety(true);
    return switch (depth) {
        16 => std.mem.readInt(u16, row[index * 2 ..][0..2], .big),
        8 => row[index],
        else => blk: {
            const bit = index * depth;
            const shift: u3 = @intCast(8 - depth - (bit % 8));
            const mask: u8 = @intCast((@as(u16, 1) << @intCast(depth)) - 1);
            break :blk (row[bit / 8] >> shift) & mask;
        },
    };
}

fn scaleTo8(value: u16, depth: u8) u8 {
    return switch (depth) {
        16 => @intCast(value >> 8),
        8 => @intCast(value),
        4 => @intCast(value * 17),
        2 => @intCast(value * 85),
        1 => @intCast(value * 255),
        else => unreachable,
    };
}

fn samplePixel(ctx: PixelContext, row: []const u8, x: u32) [4]u8 {
    const h = ctx.header;
    const d = h.bit_depth;
    const channels: usize = h.channels();
    const base = @as(usize, x) * channels;
    switch (h.color_type) {
        0 => {
            const g = sample(row, d, base);
            const alpha: u8 = switch (ctx.transparency) {
                .gray => |t| if (t == g) 0 else 255,
                else => 255,
            };
            const v = scaleTo8(g, d);
            return .{ v, v, v, alpha };
        },
        2 => {
            const r = sample(row, d, base);
            const g = sample(row, d, base + 1);
            const b = sample(row, d, base + 2);
            const alpha: u8 = switch (ctx.transparency) {
                .rgb => |t| if (t[0] == r and t[1] == g and t[2] == b) 0 else 255,
                else => 255,
            };
            return .{ scaleTo8(r, d), scaleTo8(g, d), scaleTo8(b, d), alpha };
        },
        3 => {
            const index = sample(row, d, base);
            if (index >= ctx.palette.len) return .{ 0, 0, 0, 255 };
            return ctx.palette[index];
        },
        4 => {
            const v = scaleTo8(sample(row, d, base), d);
            return .{ v, v, v, scaleTo8(sample(row, d, base + 1), d) };
        },
        6 => return .{
            scaleTo8(sample(row, d, base), d),
            scaleTo8(sample(row, d, base + 1), d),
            scaleTo8(sample(row, d, base + 2), d),
            scaleTo8(sample(row, d, base + 3), d),
        },
        else => unreachable,
    }
}

/// Encodes RGBA8 pixels as a PNG with no filtering. Used to hand cropped
/// or resized frames to terminals that accept PNG payloads.
pub fn encode(alloc: Allocator, image: Raster) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    const w = &out.writer;
    try w.writeAll(signature);

    var ihdr: [13]u8 = undefined;
    std.mem.writeInt(u32, ihdr[0..4], image.width, .big);
    std.mem.writeInt(u32, ihdr[4..8], image.height, .big);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    try writeChunk(w, "IHDR", &ihdr);

    var compressed = try std.Io.Writer.Allocating.initCapacity(alloc, 4096);
    defer compressed.deinit();
    {
        const window = try alloc.alloc(u8, std.compress.flate.max_window_len);
        defer alloc.free(window);
        var compressor = try std.compress.flate.Compress.init(&compressed.writer, window, .zlib, .level_4);
        var y: u32 = 0;
        while (y < image.height) : (y += 1) {
            try compressor.writer.writeByte(0);
            try compressor.writer.writeAll(image.row(y));
        }
        try compressor.finish();
    }
    try writeChunk(w, "IDAT", compressed.written());
    try writeChunk(w, "IEND", "");
    return out.toOwnedSlice();
}

fn writeChunk(w: *std.Io.Writer, kind: *const [4]u8, data: []const u8) !void {
    var len: [4]u8 = undefined;
    std.mem.writeInt(u32, &len, @intCast(data.len), .big);
    try w.writeAll(&len);
    try w.writeAll(kind);
    try w.writeAll(data);
    var crc = std.hash.Crc32.init();
    crc.update(kind);
    crc.update(data);
    var crc_bytes: [4]u8 = undefined;
    std.mem.writeInt(u32, &crc_bytes, crc.final(), .big);
    try w.writeAll(&crc_bytes);
}

const one_pixel_gray_png = "\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0b\x49\x44\x41\x54\x78\x9c\x63\xf8\xdf\x00\x00\x02\x81\x01\x80\x59\xe9\x2f\xfc\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82";

test "decodes a one-pixel gray-alpha PNG" {
    const alloc = std.testing.allocator;
    var image = try decode(alloc, one_pixel_gray_png, .default);
    defer image.deinit(alloc);
    try std.testing.expectEqual(@as(u32, 1), image.width);
    try std.testing.expectEqual(@as(u8, 255), image.pixel(0, 0)[0]);
}

test "encode then decode round-trips RGBA pixels" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 3, 2);
    defer image.deinit(alloc);
    for (0..6) |i| image.pixels[i * 4 ..][0..4].* = .{ @intCast(i * 40), @intCast(255 - i * 40), 7, @intCast(100 + i) };
    const encoded = try encode(alloc, image);
    defer alloc.free(encoded);
    var decoded = try decode(alloc, encoded, .default);
    defer decoded.deinit(alloc);
    try std.testing.expectEqualSlices(u8, image.pixels, decoded.pixels);
    const dims = try dimensions(encoded);
    try std.testing.expectEqual(@as(u32, 3), dims.width);
}

test "rejects corrupt CRCs, truncated data, and hostile dimensions" {
    const alloc = std.testing.allocator;
    var corrupt = one_pixel_gray_png.*;
    corrupt[30] ^= 0xff;
    try std.testing.expectError(error.InvalidImage, decode(alloc, &corrupt, .default));
    try std.testing.expectError(error.InvalidImage, decode(alloc, one_pixel_gray_png[0..40], .default));

    var image = try Raster.init(alloc, 4, 4);
    defer image.deinit(alloc);
    const encoded = try encode(alloc, image);
    defer alloc.free(encoded);
    try std.testing.expectError(error.ImageTooLarge, decode(alloc, encoded, .{ .max_dimension = 2 }));
}

test "decodes palette, low bit depth, sixteen-bit, and interlaced images" {
    const alloc = std.testing.allocator;
    // Hand-built 2x2 1-bit palette image with tRNS on index 0.
    var raw: std.ArrayList(u8) = .empty;
    defer raw.deinit(alloc);
    try raw.appendSlice(alloc, &.{ 0, 0b0100_0000, 0, 0b1000_0000 });
    const png = try buildPngForTest(alloc, 2, 2, 1, 3, 0, raw.items, &.{ 255, 0, 0, 0, 0, 255 }, &.{0});
    defer alloc.free(png);
    var image = try decode(alloc, png, .default);
    defer image.deinit(alloc);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 0 }, image.pixel(0, 0).*);
    try std.testing.expectEqual([4]u8{ 0, 0, 255, 255 }, image.pixel(1, 0).*);
    try std.testing.expectEqual([4]u8{ 0, 0, 255, 255 }, image.pixel(0, 1).*);

    // 16-bit RGB, one pixel, Paeth filter on the only row.
    const rgb16 = try buildPngForTest(alloc, 1, 1, 16, 2, 0, &.{ 4, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc }, null, null);
    defer alloc.free(rgb16);
    var deep = try decode(alloc, rgb16, .default);
    defer deep.deinit(alloc);
    try std.testing.expectEqual([4]u8{ 0x12, 0x56, 0x9a, 255 }, deep.pixel(0, 0).*);

    // 3x3 8-bit gray, Adam7 interlaced: passes 1, 2(empty), 3(empty)... are
    // laid out per the spec with the pixel value equal to its index.
    var interlaced: std.ArrayList(u8) = .empty;
    defer interlaced.deinit(alloc);
    const values = [3][3]u8{ .{ 0, 1, 2 }, .{ 3, 4, 5 }, .{ 6, 7, 8 } };
    for (adam7) |pass| {
        const size = passSize(pass, 3, 3);
        if (size.w == 0 or size.h == 0) continue;
        for (0..size.h) |py| {
            try interlaced.append(alloc, 0);
            for (0..size.w) |px| try interlaced.append(alloc, values[pass.y0 + py * pass.dy][pass.x0 + px * pass.dx]);
        }
    }
    const adam = try buildPngForTest(alloc, 3, 3, 8, 0, 1, interlaced.items, null, null);
    defer alloc.free(adam);
    var gray = try decode(alloc, adam, .default);
    defer gray.deinit(alloc);
    for (0..3) |y| for (0..3) |x| {
        try std.testing.expectEqual(values[y][x], gray.pixel(@intCast(x), @intCast(y))[0]);
    };
}

fn buildPngForTest(
    alloc: Allocator,
    width: u32,
    height: u32,
    depth: u8,
    color_type: u8,
    interlace: u8,
    filtered_rows: []const u8,
    palette: ?[]const u8,
    trns: ?[]const u8,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll(signature);
    var ihdr: [13]u8 = undefined;
    std.mem.writeInt(u32, ihdr[0..4], width, .big);
    std.mem.writeInt(u32, ihdr[4..8], height, .big);
    ihdr[8] = depth;
    ihdr[9] = color_type;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = interlace;
    try writeChunk(&out.writer, "IHDR", &ihdr);
    if (palette) |p| try writeChunk(&out.writer, "PLTE", p);
    if (trns) |t| try writeChunk(&out.writer, "tRNS", t);
    var compressed = try std.Io.Writer.Allocating.initCapacity(alloc, 4096);
    defer compressed.deinit();
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var compressor = try std.compress.flate.Compress.init(&compressed.writer, &window, .zlib, .fastest);
    try compressor.writer.writeAll(filtered_rows);
    try compressor.finish();
    try writeChunk(&out.writer, "IDAT", compressed.written());
    try writeChunk(&out.writer, "IEND", "");
    return out.toOwnedSlice();
}
