//! Format detection and dispatch for inline image decoding.

const std = @import("std");
const raster = @import("raster.zig");

pub const png = @import("codec/png.zig");
pub const gif = @import("codec/gif.zig");
pub const jpeg = @import("codec/jpeg.zig");
pub const webp = @import("codec/webp.zig");

const Allocator = std.mem.Allocator;
pub const Raster = raster.Raster;
pub const Limits = raster.Limits;

pub const Format = enum {
    png,
    gif,
    jpeg,
    webp,

    pub fn mediaType(self: Format) []const u8 {
        return switch (self) {
            .png => "image/png",
            .gif => "image/gif",
            .jpeg => "image/jpeg",
            .webp => "image/webp",
        };
    }
};

pub const DecodeError = Allocator.Error || error{ InvalidImage, ImageTooLarge, UnsupportedImage };

pub fn detect(bytes: []const u8) ?Format {
    if (png.isPng(bytes)) return .png;
    if (gif.isGif(bytes)) return .gif;
    if (jpeg.isJpeg(bytes)) return .jpeg;
    if (webp.isWebp(bytes)) return .webp;
    return null;
}

pub fn decode(alloc: Allocator, bytes: []const u8, limits: Limits) DecodeError!Raster {
    const format = detect(bytes) orelse return error.UnsupportedImage;
    return switch (format) {
        .png => png.decode(alloc, bytes, limits),
        .gif => gif.decode(alloc, bytes, limits),
        .jpeg => jpeg.decode(alloc, bytes, limits),
        .webp => webp.decode(alloc, bytes, limits),
    };
}

test {
    _ = raster;
    _ = png;
    _ = gif;
    _ = jpeg;
    _ = webp;
    _ = @import("codec/vp8.zig");
    _ = @import("svg/xml.zig");
    _ = @import("svg/style.zig");
    _ = @import("svg/canvas.zig");
    _ = @import("svg/path_data.zig");
    _ = @import("svg/text.zig");
    _ = @import("svg/render.zig");
    _ = @import("vector.zig");
    _ = @import("mermaid.zig");
    _ = @import("codec/inflate.zig");
}

test "image fixtures decode against independent reference pixels" {
    const alloc = std.testing.allocator;
    inline for (.{ "rgba.png", "palette.gif", "baseline.jpg", "progressive.jpg", "gray.jpg", "cmyk.jpg", "lossless.webp", "lossy.webp" }) |name| {
        var image = try decode(alloc, @embedFile("fixtures/" ++ name), .default);
        defer image.deinit(alloc);
        const expected = @embedFile("fixtures/" ++ name ++ ".rgba");
        try std.testing.expectEqual(@as(u32, 17), image.width);
        try std.testing.expectEqual(@as(u32, 13), image.height);
        var sum: usize = 0;
        var max_difference: usize = 0;
        for (image.pixels, expected) |actual, reference| {
            const difference = @abs(@as(i16, actual) - @as(i16, reference));
            sum += difference;
            max_difference = @max(max_difference, difference);
        }
        // Lossy codecs may round IDCT and chroma interpolation differently.
        const lossy = std.mem.endsWith(u8, name, ".jpg") or std.mem.eql(u8, name, "lossy.webp");
        if (sum > (if (lossy) @as(usize, 3) else 0) * expected.len or max_difference > (if (lossy) @as(usize, 16) else 0)) {
            std.debug.print("{s}: total channel error {d}/{d}, maximum {d}\n", .{ name, sum, expected.len, max_difference });
            return error.TestUnexpectedResult;
        }
    }
}

fn checkDecodeAllocationFailures(alloc: Allocator, bytes: []const u8) !void {
    var image = try decode(alloc, bytes, .default);
    defer image.deinit(alloc);
}

test "image fixture decoders release every failed allocation" {
    inline for (.{ "rgba.png", "palette.gif", "baseline.jpg", "progressive.jpg", "gray.jpg", "cmyk.jpg", "lossless.webp", "lossy.webp" }) |name| {
        try std.testing.checkAllAllocationFailures(std.testing.allocator, checkDecodeAllocationFailures, .{@as([]const u8, @embedFile("fixtures/" ++ name))});
    }
}

test "image fixture mutations and truncations stay within decoder limits" {
    const alloc = std.testing.allocator;
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const random = prng.random();
    inline for (.{ "rgba.png", "palette.gif", "baseline.jpg", "progressive.jpg", "gray.jpg", "cmyk.jpg", "lossless.webp", "lossy.webp" }) |name| {
        const original = @embedFile("fixtures/" ++ name);
        const mutated = try alloc.dupe(u8, original);
        defer alloc.free(mutated);
        for (0..64) |_| {
            @memcpy(mutated, original);
            const at = random.uintLessThan(usize, mutated.len);
            mutated[at] ^= @as(u8, 1) << random.int(u3);
            const length = if (random.boolean()) mutated.len else random.uintLessThan(usize, mutated.len + 1);
            if (decode(alloc, mutated[0..length], .{ .max_dimension = 128, .max_pixels = 1024 })) |decoded| {
                var image = decoded;
                defer image.deinit(alloc);
                try std.testing.expect(image.width <= 128 and image.height <= 128);
                try std.testing.expectEqual(@as(usize, image.width) * image.height * 4, image.pixels.len);
            } else |err| switch (err) {
                error.InvalidImage, error.ImageTooLarge, error.UnsupportedImage => {},
                else => return err,
            }
        }
    }
}
