//! Vector sources (SVG markup and Mermaid diagrams) rasterized for display.
//!
//! Rasters are produced at `render_scale` times the document's CSS pixel
//! size so downscaling to the terminal cell box stays sharp; layout divides
//! by the same factor to recover the natural size.

const std = @import("std");
const raster = @import("raster.zig");
const xml = @import("svg/xml.zig");
const svg_render = @import("svg/render.zig");
const mermaid = @import("mermaid.zig");

const Allocator = std.mem.Allocator;

pub const render_scale: f64 = 2;
const max_side: f64 = 4096;
const max_pixels: f64 = 12_000_000;
/// Markup larger than this is refused before parsing.
pub const max_markup_bytes: usize = 4 * 1024 * 1024;

pub const Theme = mermaid.Theme;

/// A rasterized vector source and the CSS pixel size it represents.
pub const Rendered = struct {
    image: raster.Raster,
    natural_width: u32,
    natural_height: u32,
};

pub fn looksLikeSvg(bytes: []const u8) bool {
    const head = bytes[0..@min(bytes.len, 1024)];
    return std.mem.indexOf(u8, head, "<svg") != null;
}

/// SVG files are authored for light pages and often leave the background
/// transparent with dark ink, so they are shown on white.
pub fn rasterizeSvg(alloc: Allocator, markup: []const u8) !Rendered {
    var rendered = try renderMarkup(alloc, markup);
    rendered.image.flattenOnto(.{ 255, 255, 255 });
    return rendered;
}

/// Mermaid diagrams are drawn in colors chosen for the terminal's
/// background and keep a transparent background.
pub fn rasterizeMermaid(alloc: Allocator, source: []const u8, theme: Theme) !Rendered {
    const markup = try mermaid.toSvg(alloc, source, theme);
    defer alloc.free(markup);
    return renderMarkup(alloc, markup);
}

fn renderMarkup(alloc: Allocator, markup: []const u8) !Rendered {
    if (markup.len > max_markup_bytes) return error.ImageTooLarge;
    var doc = xml.parse(alloc, markup) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidImage,
    };
    defer doc.deinit();
    if (!std.mem.eql(u8, doc.root.name, "svg")) return error.InvalidImage;
    const size = svg_render.documentSize(doc.root);
    var scale = render_scale;
    scale = @min(scale, max_side / @max(size.width, size.height));
    scale = @min(scale, @sqrt(max_pixels / (size.width * size.height)));
    const image = svg_render.render(alloc, &doc, scale) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidImage,
    };
    return .{
        .image = image,
        .natural_width = @intFromFloat(@max(1, @round(size.width))),
        .natural_height = @intFromFloat(@max(1, @round(size.height))),
    };
}

test "rasterizes SVG markup at twice its CSS size on white" {
    const alloc = std.testing.allocator;
    var rendered = try rasterizeSvg(alloc, "<svg width='10' height='5'><rect x='5' width='5' height='5' fill='black'/></svg>");
    const image = &rendered.image;
    defer image.deinit(alloc);
    try std.testing.expectEqual(@as(u32, 20), image.width);
    try std.testing.expectEqual(@as(u32, 10), rendered.natural_width);
    try std.testing.expectEqual([4]u8{ 255, 255, 255, 255 }, image.pixel(2, 2).*);
    try std.testing.expectEqual([4]u8{ 0, 0, 0, 255 }, image.pixel(15, 5).*);
    try std.testing.expectError(error.InvalidImage, rasterizeSvg(alloc, "<html/>"));
}
