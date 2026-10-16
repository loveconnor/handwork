//! Decoded image pixels shared by every codec and terminal renderer.
//!
//! Pixels are straight (non-premultiplied) RGBA8, row-major, no padding.
//! Decoders reject dimensions above `Limits` before allocating so a
//! hostile header cannot request an unbounded buffer.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Limits = struct {
    /// Largest accepted width or height, in pixels.
    max_dimension: u32 = 16_384,
    /// Largest accepted pixel count (width * height).
    max_pixels: u64 = 40_000_000,

    pub const default: Limits = .{};

    pub fn check(self: Limits, width: u64, height: u64) error{ InvalidImage, ImageTooLarge }!void {
        if (width == 0 or height == 0) return error.InvalidImage;
        if (width > self.max_dimension or height > self.max_dimension) return error.ImageTooLarge;
        if (width * height > self.max_pixels) return error.ImageTooLarge;
    }
};

pub const Raster = struct {
    width: u32,
    height: u32,
    pixels: []u8,

    pub fn init(alloc: Allocator, width: u32, height: u32) Allocator.Error!Raster {
        const pixels = try alloc.alloc(u8, @as(usize, width) * height * 4);
        @memset(pixels, 0);
        return .{ .width = width, .height = height, .pixels = pixels };
    }

    pub fn deinit(self: *Raster, alloc: Allocator) void {
        alloc.free(self.pixels);
        self.* = undefined;
    }

    pub fn clone(self: Raster, alloc: Allocator) Allocator.Error!Raster {
        return .{ .width = self.width, .height = self.height, .pixels = try alloc.dupe(u8, self.pixels) };
    }

    pub fn pixel(self: Raster, x: u32, y: u32) *[4]u8 {
        const offset = (@as(usize, y) * self.width + x) * 4;
        return self.pixels[offset..][0..4];
    }

    pub fn row(self: Raster, y: u32) []u8 {
        const stride = @as(usize, self.width) * 4;
        return self.pixels[@as(usize, y) * stride ..][0..stride];
    }

    pub fn hasTransparency(self: Raster) bool {
        var i: usize = 3;
        while (i < self.pixels.len) : (i += 4) {
            if (self.pixels[i] != 255) return true;
        }
        return false;
    }

    /// Copies rows `[top, top + height)` into a new raster.
    pub fn cropRows(self: Raster, alloc: Allocator, top: u32, height: u32) !Raster {
        if (height == 0 or top >= self.height) return error.InvalidImage;
        const rows = @min(height, self.height - top);
        const stride = @as(usize, self.width) * 4;
        const start = @as(usize, top) * stride;
        return .{
            .width = self.width,
            .height = rows,
            .pixels = try alloc.dupe(u8, self.pixels[start .. start + stride * rows]),
        };
    }

    /// Resamples to exactly `width` x `height`. Downscaling averages every
    /// covered source pixel (box filter) so thin lines in diagrams survive;
    /// upscaling uses bilinear interpolation. Color is weighted by alpha so
    /// transparent pixels do not darken edges.
    pub fn resize(self: Raster, alloc: Allocator, width: u32, height: u32) !Raster {
        if (width == 0 or height == 0) return error.InvalidImage;
        if (width == self.width and height == self.height) return self.clone(alloc);
        var out = try Raster.init(alloc, width, height);
        errdefer out.deinit(alloc);
        if (width <= self.width and height <= self.height) {
            self.boxDownscale(&out);
        } else {
            self.bilinear(&out);
        }
        return out;
    }

    fn boxDownscale(self: Raster, out: *Raster) void {
        const sx = @as(f64, @floatFromInt(self.width)) / @as(f64, @floatFromInt(out.width));
        const sy = @as(f64, @floatFromInt(self.height)) / @as(f64, @floatFromInt(out.height));
        var oy: u32 = 0;
        while (oy < out.height) : (oy += 1) {
            const y0f = @as(f64, @floatFromInt(oy)) * sy;
            const y1f = y0f + sy;
            var ox: u32 = 0;
            while (ox < out.width) : (ox += 1) {
                const x0f = @as(f64, @floatFromInt(ox)) * sx;
                const x1f = x0f + sx;
                var acc = [4]f64{ 0, 0, 0, 0 };
                var total: f64 = 0;
                var y: u32 = @intFromFloat(@floor(y0f));
                while (@as(f64, @floatFromInt(y)) < y1f and y < self.height) : (y += 1) {
                    const wy = overlap(y0f, y1f, y);
                    var x: u32 = @intFromFloat(@floor(x0f));
                    while (@as(f64, @floatFromInt(x)) < x1f and x < self.width) : (x += 1) {
                        const w = wy * overlap(x0f, x1f, x);
                        const p = self.pixel(x, y);
                        const a = @as(f64, @floatFromInt(p[3])) / 255.0;
                        acc[0] += @as(f64, @floatFromInt(p[0])) * a * w;
                        acc[1] += @as(f64, @floatFromInt(p[1])) * a * w;
                        acc[2] += @as(f64, @floatFromInt(p[2])) * a * w;
                        acc[3] += a * w;
                        total += w;
                    }
                }
                writeAveraged(out.pixel(ox, oy), acc, total);
            }
        }
    }

    fn bilinear(self: Raster, out: *Raster) void {
        const sx = @as(f64, @floatFromInt(self.width)) / @as(f64, @floatFromInt(out.width));
        const sy = @as(f64, @floatFromInt(self.height)) / @as(f64, @floatFromInt(out.height));
        const max_x = @as(f64, @floatFromInt(self.width - 1));
        const max_y = @as(f64, @floatFromInt(self.height - 1));
        var oy: u32 = 0;
        while (oy < out.height) : (oy += 1) {
            const fy = std.math.clamp((@as(f64, @floatFromInt(oy)) + 0.5) * sy - 0.5, 0, max_y);
            const y0: u32 = @intFromFloat(@floor(fy));
            const y1 = @min(y0 + 1, self.height - 1);
            const ty = fy - @floor(fy);
            var ox: u32 = 0;
            while (ox < out.width) : (ox += 1) {
                const fx = std.math.clamp((@as(f64, @floatFromInt(ox)) + 0.5) * sx - 0.5, 0, max_x);
                const x0: u32 = @intFromFloat(@floor(fx));
                const x1 = @min(x0 + 1, self.width - 1);
                const tx = fx - @floor(fx);
                var acc = [4]f64{ 0, 0, 0, 0 };
                const taps = [_]struct { x: u32, y: u32, w: f64 }{
                    .{ .x = x0, .y = y0, .w = (1 - tx) * (1 - ty) },
                    .{ .x = x1, .y = y0, .w = tx * (1 - ty) },
                    .{ .x = x0, .y = y1, .w = (1 - tx) * ty },
                    .{ .x = x1, .y = y1, .w = tx * ty },
                };
                for (taps) |tap| {
                    const p = self.pixel(tap.x, tap.y);
                    const a = @as(f64, @floatFromInt(p[3])) / 255.0;
                    acc[0] += @as(f64, @floatFromInt(p[0])) * a * tap.w;
                    acc[1] += @as(f64, @floatFromInt(p[1])) * a * tap.w;
                    acc[2] += @as(f64, @floatFromInt(p[2])) * a * tap.w;
                    acc[3] += a * tap.w;
                }
                writeAveraged(out.pixel(ox, oy), acc, 1);
            }
        }
    }

    /// Blends every pixel over an opaque background color.
    pub fn flattenOnto(self: *Raster, background: [3]u8) void {
        self.compositeOnto(background, false);
    }

    /// Resolves partial coverage for protocols without alpha, leaving empty
    /// pixels unset so transparent padding does not become a colored rectangle.
    pub fn flattenEdgesOnto(self: *Raster, background: [3]u8) void {
        self.compositeOnto(background, true);
    }

    fn compositeOnto(self: *Raster, background: [3]u8, preserve_empty: bool) void {
        var i: usize = 0;
        while (i < self.pixels.len) : (i += 4) {
            const a: u32 = self.pixels[i + 3];
            if (preserve_empty and a == 0) continue;
            inline for (0..3) |c| {
                const fg: u32 = self.pixels[i + c];
                self.pixels[i + c] = @intCast((fg * a + @as(u32, background[c]) * (255 - a) + 127) / 255);
            }
            self.pixels[i + 3] = 255;
        }
    }
};

fn overlap(lo: f64, hi: f64, index: u32) f64 {
    const cell_lo = @as(f64, @floatFromInt(index));
    return @max(0, @min(hi, cell_lo + 1) - @max(lo, cell_lo));
}

fn writeAveraged(dest: *[4]u8, acc: [4]f64, total: f64) void {
    if (total <= 0 or acc[3] <= 0) {
        dest.* = .{ 0, 0, 0, 0 };
        return;
    }
    inline for (0..3) |c| dest[c] = toByte(acc[c] / acc[3]);
    dest[3] = toByte(acc[3] / total * 255.0);
}

fn toByte(value: f64) u8 {
    return @intFromFloat(std.math.clamp(@round(value), 0, 255));
}

/// Largest size that fits inside `max_width` x `max_height` while keeping
/// the source aspect ratio. Never upscales unless `allow_upscale`.
pub fn fitWithin(width: u32, height: u32, max_width: u32, max_height: u32, allow_upscale: bool) struct { width: u32, height: u32 } {
    if (width == 0 or height == 0 or max_width == 0 or max_height == 0) return .{ .width = 0, .height = 0 };
    const scale_w = @as(f64, @floatFromInt(max_width)) / @as(f64, @floatFromInt(width));
    const scale_h = @as(f64, @floatFromInt(max_height)) / @as(f64, @floatFromInt(height));
    var scale = @min(scale_w, scale_h);
    if (!allow_upscale) scale = @min(scale, 1.0);
    return .{
        .width = @max(1, @as(u32, @intFromFloat(@round(@as(f64, @floatFromInt(width)) * scale)))),
        .height = @max(1, @as(u32, @intFromFloat(@round(@as(f64, @floatFromInt(height)) * scale)))),
    };
}

test "limits reject empty and oversized dimensions" {
    const limits = Limits.default;
    try std.testing.expectError(error.InvalidImage, limits.check(0, 10));
    try std.testing.expectError(error.ImageTooLarge, limits.check(20_000, 1));
    try std.testing.expectError(error.ImageTooLarge, limits.check(10_000, 10_000));
    try limits.check(1920, 1080);
}

test "box downscale averages covered pixels and respects alpha" {
    const alloc = std.testing.allocator;
    var src = try Raster.init(alloc, 2, 1);
    defer src.deinit(alloc);
    src.pixel(0, 0).* = .{ 255, 0, 0, 255 };
    src.pixel(1, 0).* = .{ 0, 0, 255, 0 };
    var out = try src.resize(alloc, 1, 1);
    defer out.deinit(alloc);
    // The transparent blue pixel contributes coverage but no color.
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 128 }, out.pixel(0, 0).*);
}

test "bilinear upscale keeps a solid image solid" {
    const alloc = std.testing.allocator;
    var src = try Raster.init(alloc, 2, 2);
    defer src.deinit(alloc);
    for (0..4) |i| src.pixels[i * 4 ..][0..4].* = .{ 10, 20, 30, 255 };
    var out = try src.resize(alloc, 5, 3);
    defer out.deinit(alloc);
    try std.testing.expectEqual([4]u8{ 10, 20, 30, 255 }, out.pixel(4, 2).*);
}

test "fitWithin preserves aspect ratio and refuses to upscale by default" {
    const fit = fitWithin(1000, 500, 200, 200, false);
    try std.testing.expectEqual(@as(u32, 200), fit.width);
    try std.testing.expectEqual(@as(u32, 100), fit.height);
    const small = fitWithin(10, 10, 200, 100, false);
    try std.testing.expectEqual(@as(u32, 10), small.width);
}

test "flattenEdgesOnto preserves empty pixels and blends subpixel coverage" {
    const alloc = std.testing.allocator;
    for ([_][3]u8{ .{ 20, 40, 60 }, .{ 255, 255, 255 } }) |background| {
        var image = try Raster.init(alloc, 7, 1);
        defer image.deinit(alloc);
        const alphas = [_]u8{ 0, 1, 64, 127, 128, 254, 255 };
        for (alphas, 0..) |alpha, x| image.pixel(@intCast(x), 0).* = .{ 200, 160, 120, alpha };
        image.flattenEdgesOnto(background);
        try std.testing.expectEqual([4]u8{ 200, 160, 120, 0 }, image.pixel(0, 0).*);
        try std.testing.expectEqual([4]u8{ 200, 160, 120, 255 }, image.pixel(6, 0).*);
        try std.testing.expectEqual(@as(u8, 255), image.pixel(2, 0)[3]);
        if (background[0] == 20) try std.testing.expectEqual([4]u8{ 65, 70, 75, 255 }, image.pixel(2, 0).*);
        if (background[0] == 255) try std.testing.expectEqual([4]u8{ 241, 231, 221, 255 }, image.pixel(2, 0).*);
    }
}

test "flattenOnto composites over the background" {
    const alloc = std.testing.allocator;
    var src = try Raster.init(alloc, 1, 1);
    defer src.deinit(alloc);
    src.pixel(0, 0).* = .{ 255, 255, 255, 0 };
    src.flattenOnto(.{ 1, 2, 3 });
    try std.testing.expectEqual([4]u8{ 1, 2, 3, 255 }, src.pixel(0, 0).*);
}
