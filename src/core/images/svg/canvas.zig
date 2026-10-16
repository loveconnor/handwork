//! Anti-aliased vector rasterization onto an RGBA raster: polygon filling
//! (nonzero and even-odd), stroking (joins, caps, dashes), and solid or
//! gradient paint with source-over compositing.
//!
//! Geometry is flattened and stroked in user space, then transformed, so
//! affine transforms (including non-uniform scales) shape strokes exactly.

const std = @import("std");
const raster_mod = @import("../raster.zig");

const Allocator = std.mem.Allocator;
const Raster = raster_mod.Raster;

pub const Point = struct {
    x: f64,
    y: f64,

    fn add(a: Point, b: Point) Point {
        return .{ .x = a.x + b.x, .y = a.y + b.y };
    }

    fn sub(a: Point, b: Point) Point {
        return .{ .x = a.x - b.x, .y = a.y - b.y };
    }

    fn scale(a: Point, s: f64) Point {
        return .{ .x = a.x * s, .y = a.y * s };
    }

    fn length(a: Point) f64 {
        return @sqrt(a.x * a.x + a.y * a.y);
    }

    fn lerp(a: Point, b: Point, t: f64) Point {
        return .{ .x = a.x + (b.x - a.x) * t, .y = a.y + (b.y - a.y) * t };
    }
};

/// Affine transform [a c e; b d f; 0 0 1].
pub const Transform = struct {
    a: f64 = 1,
    b: f64 = 0,
    c: f64 = 0,
    d: f64 = 1,
    e: f64 = 0,
    f: f64 = 0,

    pub const identity: Transform = .{};

    pub fn apply(t: Transform, p: Point) Point {
        return .{ .x = t.a * p.x + t.c * p.y + t.e, .y = t.b * p.x + t.d * p.y + t.f };
    }

    /// Returns `t` followed by `self` (`self * t`).
    pub fn multiply(self: Transform, t: Transform) Transform {
        return .{
            .a = self.a * t.a + self.c * t.b,
            .b = self.b * t.a + self.d * t.b,
            .c = self.a * t.c + self.c * t.d,
            .d = self.b * t.c + self.d * t.d,
            .e = self.a * t.e + self.c * t.f + self.e,
            .f = self.b * t.e + self.d * t.f + self.f,
        };
    }

    pub fn translate(x: f64, y: f64) Transform {
        return .{ .e = x, .f = y };
    }

    pub fn scaling(x: f64, y: f64) Transform {
        return .{ .a = x, .d = y };
    }

    pub fn rotation(degrees: f64) Transform {
        const r = degrees * std.math.pi / 180.0;
        return .{ .a = @cos(r), .b = @sin(r), .c = -@sin(r), .d = @cos(r) };
    }

    pub fn determinant(t: Transform) f64 {
        return t.a * t.d - t.b * t.c;
    }

    pub fn invert(t: Transform) ?Transform {
        const det = t.determinant();
        if (@abs(det) < 1e-12 or !std.math.isFinite(det)) return null;
        const inv = 1.0 / det;
        return .{
            .a = t.d * inv,
            .b = -t.b * inv,
            .c = -t.c * inv,
            .d = t.a * inv,
            .e = (t.c * t.f - t.d * t.e) * inv,
            .f = (t.b * t.e - t.a * t.f) * inv,
        };
    }

    /// Geometric mean scale, used to pick flattening tolerances.
    pub fn meanScale(t: Transform) f64 {
        return @sqrt(@abs(t.determinant()));
    }
};

/// A polyline; closed contours repeat no point (closure is implicit).
pub const Contour = struct {
    points: std.ArrayList(Point) = .empty,
    closed: bool = false,
};

/// A flattened path: contours in user space.
pub const Path = struct {
    contours: std.ArrayList(Contour) = .empty,
    alloc: Allocator,
    /// Flattening tolerance in user units.
    tolerance: f64 = 0.25,

    pub fn init(alloc: Allocator, tolerance: f64) Path {
        return .{ .alloc = alloc, .tolerance = @max(tolerance, 1e-4) };
    }

    pub fn deinit(self: *Path) void {
        for (self.contours.items) |*c| c.points.deinit(self.alloc);
        self.contours.deinit(self.alloc);
    }

    fn current(self: *Path) ?*Contour {
        if (self.contours.items.len == 0) return null;
        return &self.contours.items[self.contours.items.len - 1];
    }

    pub fn moveTo(self: *Path, p: Point) !void {
        try self.contours.append(self.alloc, .{});
        try self.current().?.points.append(self.alloc, p);
    }

    pub fn lineTo(self: *Path, p: Point) !void {
        const c = self.current() orelse return self.moveTo(p);
        try c.points.append(self.alloc, p);
    }

    pub fn lastPoint(self: *Path) ?Point {
        const c = self.current() orelse return null;
        if (c.points.items.len == 0) return null;
        return c.points.items[c.points.items.len - 1];
    }

    pub fn close(self: *Path) void {
        if (self.current()) |c| c.closed = true;
    }

    pub fn cubicTo(self: *Path, c1: Point, c2: Point, p: Point) !void {
        const p0 = self.lastPoint() orelse return self.moveTo(p);
        const estimate = p0.sub(c1).length() + c1.sub(c2).length() + c2.sub(p).length();
        const steps = segmentCount(estimate, self.tolerance);
        var i: usize = 1;
        while (i <= steps) : (i += 1) {
            const t = @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(steps));
            const mt = 1 - t;
            const point = p0.scale(mt * mt * mt).add(c1.scale(3 * mt * mt * t)).add(c2.scale(3 * mt * t * t)).add(p.scale(t * t * t));
            try self.lineTo(point);
        }
    }

    pub fn quadTo(self: *Path, c: Point, p: Point) !void {
        const p0 = self.lastPoint() orelse return self.moveTo(p);
        // Elevate to a cubic: control points at 2/3 toward the quadratic one.
        try self.cubicTo(p0.lerp(c, 2.0 / 3.0), p.lerp(c, 2.0 / 3.0), p);
    }

    /// SVG elliptical arc from the current point (SVG 1.1 F.6.5).
    pub fn arcTo(self: *Path, rx_in: f64, ry_in: f64, rotation_deg: f64, large_arc: bool, sweep: bool, p: Point) !void {
        const p0 = self.lastPoint() orelse return self.moveTo(p);
        var rx = @abs(rx_in);
        var ry = @abs(ry_in);
        if (rx == 0 or ry == 0 or (p0.x == p.x and p0.y == p.y)) return self.lineTo(p);
        const phi = rotation_deg * std.math.pi / 180.0;
        const cos_phi = @cos(phi);
        const sin_phi = @sin(phi);
        const dx = (p0.x - p.x) / 2;
        const dy = (p0.y - p.y) / 2;
        const x1 = cos_phi * dx + sin_phi * dy;
        const y1 = -sin_phi * dx + cos_phi * dy;
        const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (lambda > 1) {
            rx *= @sqrt(lambda);
            ry *= @sqrt(lambda);
        }
        const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        var coef = @sqrt(@max(0, num / den));
        if (large_arc == sweep) coef = -coef;
        const cx1 = coef * rx * y1 / ry;
        const cy1 = -coef * ry * x1 / rx;
        const cx = cos_phi * cx1 - sin_phi * cy1 + (p0.x + p.x) / 2;
        const cy = sin_phi * cx1 + cos_phi * cy1 + (p0.y + p.y) / 2;
        const theta1 = vectorAngle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
        var delta = vectorAngle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep and delta > 0) delta -= 2 * std.math.pi;
        if (sweep and delta < 0) delta += 2 * std.math.pi;
        const steps = segmentCount(@abs(delta) * @max(rx, ry), self.tolerance);
        var i: usize = 1;
        while (i < steps) : (i += 1) {
            const angle = theta1 + delta * @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(steps));
            const ex = rx * @cos(angle);
            const ey = ry * @sin(angle);
            try self.lineTo(.{ .x = cos_phi * ex - sin_phi * ey + cx, .y = sin_phi * ex + cos_phi * ey + cy });
        }
        // End exactly on the requested point so following segments join.
        try self.lineTo(p);
    }

    pub fn ellipse(self: *Path, cx: f64, cy: f64, rx: f64, ry: f64) !void {
        const steps = @max(8, segmentCount(2 * std.math.pi * @max(rx, ry), self.tolerance));
        try self.moveTo(.{ .x = cx + rx, .y = cy });
        var i: usize = 1;
        while (i < steps) : (i += 1) {
            const angle = 2 * std.math.pi * @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(steps));
            try self.lineTo(.{ .x = cx + rx * @cos(angle), .y = cy + ry * @sin(angle) });
        }
        self.close();
    }

    /// Bounding box of all points, in user space.
    pub fn bounds(self: *const Path) ?struct { min: Point, max: Point } {
        var min = Point{ .x = std.math.inf(f64), .y = std.math.inf(f64) };
        var max = Point{ .x = -std.math.inf(f64), .y = -std.math.inf(f64) };
        var any = false;
        for (self.contours.items) |c| for (c.points.items) |p| {
            min = .{ .x = @min(min.x, p.x), .y = @min(min.y, p.y) };
            max = .{ .x = @max(max.x, p.x), .y = @max(max.y, p.y) };
            any = true;
        };
        return if (any) .{ .min = min, .max = max } else null;
    }
};

fn vectorAngle(ux: f64, uy: f64, vx: f64, vy: f64) f64 {
    const dot = ux * vx + uy * vy;
    const len = @sqrt(ux * ux + uy * uy) * @sqrt(vx * vx + vy * vy);
    var angle = std.math.acos(std.math.clamp(dot / len, -1, 1));
    if (ux * vy - uy * vx < 0) angle = -angle;
    return angle;
}

/// Segments needed so a curve of `length` deviates less than `tolerance`.
fn segmentCount(length: f64, tolerance: f64) usize {
    if (!std.math.isFinite(length)) return 1;
    const n = @ceil(@sqrt(length / tolerance) * 0.75);
    return @intFromFloat(std.math.clamp(n, 1, 256));
}

// ---------------------------------------------------------------------------
// Paint

pub const Rgba = struct { r: f32, g: f32, b: f32, a: f32 };

pub const GradientStop = struct {
    offset: f32,
    color: Rgba,
};

pub const Spread = enum { pad, reflect, repeat };

pub const Gradient = struct {
    kind: enum { linear, radial },
    /// Device pixel -> gradient space.
    inverse: Transform,
    /// Linear: x1,y1 -> x2,y2. Radial: center (x1,y1), radius in x2.
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    stops: []const GradientStop,
    spread: Spread,
    opacity: f32,

    fn colorAt(self: *const Gradient, device: Point) Rgba {
        const p = self.inverse.apply(device);
        var t: f64 = switch (self.kind) {
            .linear => blk: {
                const dx = self.x2 - self.x1;
                const dy = self.y2 - self.y1;
                const len2 = dx * dx + dy * dy;
                break :blk if (len2 == 0) 0 else ((p.x - self.x1) * dx + (p.y - self.y1) * dy) / len2;
            },
            .radial => if (self.x2 <= 0) 1 else (Point{ .x = p.x - self.x1, .y = p.y - self.y1 }).length() / self.x2,
        };
        t = switch (self.spread) {
            .pad => std.math.clamp(t, 0, 1),
            .repeat => t - @floor(t),
            .reflect => blk: {
                const m = @mod(t, 2.0);
                break :blk if (m > 1) 2 - m else m;
            },
        };
        const tf: f32 = @floatCast(t);
        var c = self.stops[self.stops.len - 1].color;
        if (tf <= self.stops[0].offset) {
            c = self.stops[0].color;
        } else for (self.stops[1..], 1..) |stop, i| {
            if (tf <= stop.offset) {
                const prev = self.stops[i - 1];
                const span = stop.offset - prev.offset;
                const k = if (span <= 0) 1 else (tf - prev.offset) / span;
                c = .{
                    .r = prev.color.r + (stop.color.r - prev.color.r) * k,
                    .g = prev.color.g + (stop.color.g - prev.color.g) * k,
                    .b = prev.color.b + (stop.color.b - prev.color.b) * k,
                    .a = prev.color.a + (stop.color.a - prev.color.a) * k,
                };
                break;
            }
        }
        c.a *= self.opacity;
        return c;
    }
};

pub const Paint = union(enum) {
    solid: Rgba,
    gradient: *const Gradient,
};

pub const FillRule = enum { nonzero, evenodd };

// ---------------------------------------------------------------------------
// Fill

const Edge = struct {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    /// +1 for downward edges, -1 for upward.
    winding: i32,
    /// dx/dy
    slope: f64,
};

const Crossing = struct {
    x: f64,
    winding: i32,

    fn less(_: void, a: Crossing, b: Crossing) bool {
        return a.x < b.x;
    }
};

const sub_scanlines = 5;

pub const Canvas = struct {
    alloc: Allocator,
    target: *Raster,
    /// Hard ceiling on edges per fill, bounding work for hostile input.
    max_edges: usize = 4_000_000,

    pub fn init(alloc: Allocator, target: *Raster) Canvas {
        return .{ .alloc = alloc, .target = target };
    }

    /// Fills device-space polygons.
    pub fn fillPolygons(self: *Canvas, polygons: []const []const Point, rule: FillRule, paint: Paint) !void {
        var edges: std.ArrayList(Edge) = .empty;
        defer edges.deinit(self.alloc);
        var min_y = std.math.inf(f64);
        var max_y = -std.math.inf(f64);
        for (polygons) |poly| {
            if (poly.len < 2) continue;
            for (poly, 0..) |p0, i| {
                const p1 = poly[(i + 1) % poly.len];
                if (!std.math.isFinite(p0.x) or !std.math.isFinite(p0.y) or !std.math.isFinite(p1.x) or !std.math.isFinite(p1.y)) continue;
                if (p0.y == p1.y) continue;
                if (edges.items.len >= self.max_edges) return error.TooComplex;
                const down = p0.y < p1.y;
                const top = if (down) p0 else p1;
                const bottom = if (down) p1 else p0;
                try edges.append(self.alloc, .{
                    .x0 = top.x,
                    .y0 = top.y,
                    .x1 = bottom.x,
                    .y1 = bottom.y,
                    .winding = if (down) 1 else -1,
                    .slope = (bottom.x - top.x) / (bottom.y - top.y),
                });
                min_y = @min(min_y, top.y);
                max_y = @max(max_y, bottom.y);
            }
        }
        if (edges.items.len == 0) return;
        std.mem.sort(Edge, edges.items, {}, struct {
            fn less(_: void, a: Edge, b: Edge) bool {
                return a.y0 < b.y0;
            }
        }.less);

        const width = self.target.width;
        const height = self.target.height;
        const row_start: u32 = @intFromFloat(std.math.clamp(@floor(min_y), 0, @as(f64, @floatFromInt(height))));
        const row_end: u32 = @intFromFloat(std.math.clamp(@ceil(max_y), 0, @as(f64, @floatFromInt(height))));
        if (row_start >= row_end) return;

        const cover = try self.alloc.alloc(f32, width + 1);
        defer self.alloc.free(cover);
        var active: std.ArrayList(usize) = .empty;
        defer active.deinit(self.alloc);
        var crossings: std.ArrayList(Crossing) = .empty;
        defer crossings.deinit(self.alloc);
        var next_edge: usize = 0;
        const width_f = @as(f64, @floatFromInt(width));

        var row = row_start;
        while (row < row_end) : (row += 1) {
            @memset(cover, 0);
            var touched_min: usize = width;
            var touched_max: usize = 0;
            for (0..sub_scanlines) |s| {
                const sy = @as(f64, @floatFromInt(row)) + (@as(f64, @floatFromInt(s)) + 0.5) / sub_scanlines;
                while (next_edge < edges.items.len and edges.items[next_edge].y0 <= sy) : (next_edge += 1) {
                    try active.append(self.alloc, next_edge);
                }
                crossings.clearRetainingCapacity();
                var k: usize = 0;
                while (k < active.items.len) {
                    const e = edges.items[active.items[k]];
                    if (e.y1 <= sy) {
                        _ = active.swapRemove(k);
                        continue;
                    }
                    if (e.y0 <= sy) try crossings.append(self.alloc, .{ .x = e.x0 + (sy - e.y0) * e.slope, .winding = e.winding });
                    k += 1;
                }
                std.mem.sort(Crossing, crossings.items, {}, Crossing.less);
                var winding: i32 = 0;
                for (crossings.items, 0..) |c, ci| {
                    const was_inside = inside(winding, rule);
                    winding += c.winding;
                    if (!was_inside and inside(winding, rule)) {
                        // Span starts here; find where it ends.
                        var w = winding;
                        var end_x = c.x;
                        for (crossings.items[ci + 1 ..]) |d| {
                            w += d.winding;
                            end_x = d.x;
                            if (!inside(w, rule)) break;
                        }
                        const xa = std.math.clamp(c.x, 0, width_f);
                        const xb = std.math.clamp(end_x, 0, width_f);
                        if (xb > xa) {
                            addSpan(cover, xa, xb, 1.0 / @as(f32, sub_scanlines));
                            touched_min = @min(touched_min, @as(usize, @intFromFloat(@floor(xa))));
                            touched_max = @max(touched_max, @as(usize, @intFromFloat(@ceil(xb))));
                        }
                    }
                }
            }
            if (touched_min >= touched_max) continue;
            var x = touched_min;
            while (x < @min(touched_max, width)) : (x += 1) {
                const coverage = @min(cover[x], 1.0);
                if (coverage <= 0.0005) continue;
                const color = switch (paint) {
                    .solid => |c| c,
                    .gradient => |g| g.colorAt(.{ .x = @as(f64, @floatFromInt(x)) + 0.5, .y = @as(f64, @floatFromInt(row)) + 0.5 }),
                };
                blend(self.target.pixel(@intCast(x), row), color, coverage);
            }
        }
    }

    /// Fills a user-space path under `ctm`.
    pub fn fillPath(self: *Canvas, path: *const Path, ctm: Transform, rule: FillRule, paint: Paint) !void {
        var polygons: std.ArrayList([]const Point) = .empty;
        defer {
            for (polygons.items) |p| self.alloc.free(p);
            polygons.deinit(self.alloc);
        }
        for (path.contours.items) |contour| {
            if (contour.points.items.len < 3) continue;
            const device = try self.alloc.alloc(Point, contour.points.items.len);
            for (contour.points.items, device) |p, *d| d.* = ctm.apply(p);
            try polygons.append(self.alloc, device);
        }
        try self.fillPolygons(polygons.items, rule, paint);
    }

    pub fn strokePath(self: *Canvas, path: *const Path, ctm: Transform, style: StrokeStyle, paint: Paint) !void {
        var outline = Outline{ .alloc = self.alloc };
        defer outline.deinit();
        const device_scale = ctm.meanScale();
        for (path.contours.items) |contour| {
            var pieces: std.ArrayList(Contour) = .empty;
            defer {
                for (pieces.items) |*piece| piece.points.deinit(self.alloc);
                pieces.deinit(self.alloc);
            }
            try dash(self.alloc, contour, style.dashes, style.dash_offset, &pieces);
            for (pieces.items) |piece| try strokeContour(&outline, piece, style, device_scale);
        }
        var polygons: std.ArrayList([]const Point) = .empty;
        defer polygons.deinit(self.alloc);
        for (outline.polygons.items) |poly| {
            for (poly.items) |*p| p.* = ctm.apply(p.*);
            try polygons.append(self.alloc, poly.items);
        }
        try self.fillPolygons(polygons.items, .nonzero, paint);
    }
};

fn inside(winding: i32, rule: FillRule) bool {
    return switch (rule) {
        .nonzero => winding != 0,
        .evenodd => @mod(winding, 2) != 0,
    };
}

/// Adds `weight` times the horizontal overlap of [xa, xb) with each pixel.
fn addSpan(cover: []f32, xa: f64, xb: f64, weight: f32) void {
    const first: usize = @intFromFloat(@floor(xa));
    const last: usize = @intFromFloat(@floor(xb));
    if (first == last) {
        if (first < cover.len) cover[first] += @as(f32, @floatCast(xb - xa)) * weight;
        return;
    }
    cover[first] += @as(f32, @floatCast(@as(f64, @floatFromInt(first + 1)) - xa)) * weight;
    var x = first + 1;
    while (x < last) : (x += 1) cover[x] += weight;
    if (last < cover.len) cover[last] += @as(f32, @floatCast(xb - @as(f64, @floatFromInt(last)))) * weight;
}

/// Source-over onto a straight-alpha pixel.
fn blend(dst: *[4]u8, src: Rgba, coverage: f32) void {
    const sa = std.math.clamp(src.a * coverage, 0, 1);
    if (sa <= 0) return;
    const da = @as(f32, @floatFromInt(dst[3])) / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    const channels = [3]f32{ src.r, src.g, src.b };
    inline for (0..3) |i| {
        const dc = @as(f32, @floatFromInt(dst[i])) / 255;
        const oc = (channels[i] * sa + dc * da * (1 - sa)) / oa;
        dst[i] = @intFromFloat(std.math.clamp(@round(oc * 255), 0, 255));
    }
    dst[3] = @intFromFloat(std.math.clamp(@round(oa * 255), 0, 255));
}

// ---------------------------------------------------------------------------
// Stroke

pub const LineJoin = enum { miter, round, bevel };
pub const LineCap = enum { butt, round, square };

pub const StrokeStyle = struct {
    width: f64,
    join: LineJoin = .miter,
    cap: LineCap = .butt,
    miter_limit: f64 = 4,
    dashes: []const f64 = &.{},
    dash_offset: f64 = 0,
};

const Outline = struct {
    alloc: Allocator,
    polygons: std.ArrayList(std.ArrayList(Point)) = .empty,

    fn deinit(self: *Outline) void {
        for (self.polygons.items) |*p| p.deinit(self.alloc);
        self.polygons.deinit(self.alloc);
    }

    /// Adds a polygon oriented so every piece has positive winding, which
    /// makes a nonzero fill of all pieces their union.
    fn add(self: *Outline, points: []const Point) !void {
        if (points.len < 3) return;
        var area: f64 = 0;
        for (points, 0..) |p, i| {
            const q = points[(i + 1) % points.len];
            area += p.x * q.y - q.x * p.y;
        }
        var poly: std.ArrayList(Point) = .empty;
        try poly.ensureTotalCapacity(self.alloc, points.len);
        if (area >= 0) {
            poly.appendSliceAssumeCapacity(points);
        } else {
            var i = points.len;
            while (i > 0) {
                i -= 1;
                poly.appendAssumeCapacity(points[i]);
            }
        }
        try self.polygons.append(self.alloc, poly);
    }

    fn addCircle(self: *Outline, center: Point, radius: f64, device_scale: f64) !void {
        const steps = std.math.clamp(@as(usize, @intFromFloat(@ceil(radius * device_scale * 1.5))), 8, 64);
        var points: [64]Point = undefined;
        for (0..steps) |i| {
            const angle = 2 * std.math.pi * @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(steps));
            points[i] = .{ .x = center.x + radius * @cos(angle), .y = center.y + radius * @sin(angle) };
        }
        try self.add(points[0..steps]);
    }
};

fn strokeContour(outline: *Outline, contour: Contour, style: StrokeStyle, device_scale: f64) !void {
    const half = style.width / 2;
    if (!(half > 0)) return;
    // Drop repeated points; they have no direction.
    var points: std.ArrayList(Point) = .empty;
    defer points.deinit(outline.alloc);
    for (contour.points.items) |p| {
        if (points.items.len > 0 and points.items[points.items.len - 1].sub(p).length() < 1e-9) continue;
        try points.append(outline.alloc, p);
    }
    if (contour.closed and points.items.len > 1 and points.items[0].sub(points.items[points.items.len - 1]).length() < 1e-9) {
        _ = points.pop();
    }
    const pts = points.items;
    if (pts.len == 0) return;
    if (pts.len == 1) {
        // A zero-length subpath shows only round or square caps.
        switch (style.cap) {
            .round => try outline.addCircle(pts[0], half, device_scale),
            .square => try outline.add(&.{
                .{ .x = pts[0].x - half, .y = pts[0].y - half }, .{ .x = pts[0].x + half, .y = pts[0].y - half },
                .{ .x = pts[0].x + half, .y = pts[0].y + half }, .{ .x = pts[0].x - half, .y = pts[0].y + half },
            }),
            .butt => {},
        }
        return;
    }
    const segment_count = if (contour.closed) pts.len else pts.len - 1;
    for (0..segment_count) |i| {
        var a = pts[i];
        var b = pts[(i + 1) % pts.len];
        const dir = b.sub(a).scale(1 / b.sub(a).length());
        if (!contour.closed and style.cap == .square) {
            if (i == 0) a = a.sub(dir.scale(half));
            if (i == segment_count - 1) b = b.add(dir.scale(half));
        }
        const n = Point{ .x = -dir.y * half, .y = dir.x * half };
        try outline.add(&.{ a.add(n), b.add(n), b.sub(n), a.sub(n) });
    }
    // Joins at interior vertices (every vertex of a closed contour).
    const first_join: usize = if (contour.closed) 0 else 1;
    const last_join: usize = if (contour.closed) pts.len else pts.len - 1;
    var v = first_join;
    while (v < last_join) : (v += 1) {
        const prev = pts[(v + pts.len - 1) % pts.len];
        const at = pts[v];
        const next = pts[(v + 1) % pts.len];
        try addJoin(outline, prev, at, next, style, half, device_scale);
    }
    if (!contour.closed and style.cap == .round) {
        try outline.addCircle(pts[0], half, device_scale);
        try outline.addCircle(pts[pts.len - 1], half, device_scale);
    }
}

fn addJoin(outline: *Outline, prev: Point, at: Point, next: Point, style: StrokeStyle, half: f64, device_scale: f64) !void {
    const d0 = at.sub(prev).scale(1 / at.sub(prev).length());
    const d1 = next.sub(at).scale(1 / next.sub(at).length());
    const cross = d0.x * d1.y - d0.y * d1.x;
    if (@abs(cross) < 1e-9 and d0.x * d1.x + d0.y * d1.y > 0) return; // straight
    if (style.join == .round) return outline.addCircle(at, half, device_scale);
    // The outer side is left of the turn for clockwise turns in y-down space.
    const sign: f64 = if (cross > 0) -1 else 1;
    const n0 = Point{ .x = -d0.y * half * sign, .y = d0.x * half * sign };
    const n1 = Point{ .x = -d1.y * half * sign, .y = d1.x * half * sign };
    const p0 = at.add(n0);
    const p1 = at.add(n1);
    if (style.join == .miter) {
        const cos_theta = d0.x * d1.x + d0.y * d1.y;
        const miter_ratio = 1 / @sqrt(@max(1e-12, (1 + cos_theta) / 2));
        if (miter_ratio <= style.miter_limit) {
            const bisector = n0.add(n1);
            const bl = bisector.length();
            if (bl > 1e-12) {
                const tip = at.add(bisector.scale(half * miter_ratio / bl));
                return outline.add(&.{ at, p0, tip, p1 });
            }
        }
    }
    try outline.add(&.{ at, p0, p1 });
}

/// Splits a contour into dashes; without a dash pattern returns it whole.
fn dash(alloc: Allocator, contour: Contour, dashes: []const f64, offset: f64, out: *std.ArrayList(Contour)) !void {
    var total: f64 = 0;
    for (dashes) |d| total += @max(d, 0);
    if (dashes.len == 0 or total <= 0) {
        var copy: Contour = .{ .closed = contour.closed };
        try copy.points.appendSlice(alloc, contour.points.items);
        try out.append(alloc, copy);
        return;
    }
    var pts = contour.points.items;
    var closed_points: std.ArrayList(Point) = .empty;
    defer closed_points.deinit(alloc);
    if (contour.closed and pts.len > 0) {
        try closed_points.appendSlice(alloc, pts);
        try closed_points.append(alloc, pts[0]);
        pts = closed_points.items;
    }
    // Position within the pattern at the start of the contour.
    var phase = @mod(offset, total);
    var index: usize = 0;
    while (phase >= dashes[index]) {
        phase -= dashes[index];
        index = (index + 1) % dashes.len;
    }
    var remaining = dashes[index] - phase;
    var on = index % 2 == 0;
    var current: ?Contour = null;
    if (on and pts.len > 0) {
        current = .{};
        try current.?.points.append(alloc, pts[0]);
    }
    var guard: usize = 0;
    for (pts[0..pts.len -| 1], 0..) |a_start, i| {
        var a = a_start;
        const b = pts[i + 1];
        var seg_len = b.sub(a).length();
        while (seg_len > remaining) {
            guard += 1;
            if (guard > 1_000_000) return; // pathological patterns
            const split = a.lerp(b, remaining / seg_len);
            if (on) {
                try current.?.points.append(alloc, split);
                try out.append(alloc, current.?);
                current = null;
            } else {
                current = .{};
                try current.?.points.append(alloc, split);
            }
            on = !on;
            seg_len -= remaining;
            a = split;
            index = (index + 1) % dashes.len;
            remaining = dashes[index];
        }
        remaining -= seg_len;
        if (on) try current.?.points.append(alloc, b);
    }
    if (current) |c| try out.append(alloc, c);
}

test "transforms compose and invert" {
    const t = Transform.translate(10, 5).multiply(Transform.scaling(2, 3));
    const p = t.apply(.{ .x = 1, .y = 1 });
    try std.testing.expectEqual(Point{ .x = 12, .y = 8 }, p);
    const back = t.invert().?.apply(p);
    try std.testing.expectApproxEqAbs(@as(f64, 1), back.x, 1e-9);
}

test "fills a rectangle with exact edge coverage" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 4, 4);
    defer image.deinit(alloc);
    var canvas = Canvas.init(alloc, &image);
    const square = [_]Point{ .{ .x = 0.5, .y = 0 }, .{ .x = 3, .y = 0 }, .{ .x = 3, .y = 4 }, .{ .x = 0.5, .y = 4 } };
    try canvas.fillPolygons(&.{&square}, .nonzero, .{ .solid = .{ .r = 1, .g = 0, .b = 0, .a = 1 } });
    try std.testing.expectEqual(@as(u8, 128), image.pixel(0, 1)[3]);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, image.pixel(1, 1).*);
    try std.testing.expectEqual(@as(u8, 0), image.pixel(3, 1)[3]);
}

test "even-odd leaves the inner square of nested contours empty" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 10, 10);
    defer image.deinit(alloc);
    var canvas = Canvas.init(alloc, &image);
    const outer = [_]Point{ .{ .x = 0, .y = 0 }, .{ .x = 10, .y = 0 }, .{ .x = 10, .y = 10 }, .{ .x = 0, .y = 10 } };
    const inner = [_]Point{ .{ .x = 3, .y = 3 }, .{ .x = 7, .y = 3 }, .{ .x = 7, .y = 7 }, .{ .x = 3, .y = 7 } };
    try canvas.fillPolygons(&.{ &outer, &inner }, .evenodd, .{ .solid = .{ .r = 0, .g = 0, .b = 1, .a = 1 } });
    try std.testing.expectEqual(@as(u8, 0), image.pixel(5, 5)[3]);
    try std.testing.expectEqual(@as(u8, 255), image.pixel(1, 5)[3]);
    @memset(image.pixels, 0);
    try canvas.fillPolygons(&.{ &outer, &inner }, .nonzero, .{ .solid = .{ .r = 0, .g = 0, .b = 1, .a = 1 } });
    try std.testing.expectEqual(@as(u8, 255), image.pixel(5, 5)[3]);
}

test "strokes cover their width and dashes leave gaps" {
    const alloc = std.testing.allocator;
    var image = try Raster.init(alloc, 20, 10);
    defer image.deinit(alloc);
    var canvas = Canvas.init(alloc, &image);
    var path = Path.init(alloc, 0.25);
    defer path.deinit();
    try path.moveTo(.{ .x = 0, .y = 5 });
    try path.lineTo(.{ .x = 20, .y = 5 });
    try canvas.strokePath(&path, .identity, .{ .width = 2, .dashes = &.{ 4, 4 } }, .{ .solid = .{ .r = 0, .g = 0, .b = 0, .a = 1 } });
    try std.testing.expectEqual(@as(u8, 255), image.pixel(1, 4)[3]);
    try std.testing.expectEqual(@as(u8, 255), image.pixel(1, 5)[3]);
    try std.testing.expectEqual(@as(u8, 0), image.pixel(1, 2)[3]);
    try std.testing.expectEqual(@as(u8, 0), image.pixel(5, 5)[3]);
    try std.testing.expectEqual(@as(u8, 255), image.pixel(9, 5)[3]);
}

test "arcs reach their end point and ellipses close" {
    const alloc = std.testing.allocator;
    var path = Path.init(alloc, 0.1);
    defer path.deinit();
    try path.moveTo(.{ .x = 0, .y = 0 });
    try path.arcTo(5, 5, 0, false, true, .{ .x = 10, .y = 0 });
    const last = path.lastPoint().?;
    try std.testing.expectApproxEqAbs(@as(f64, 10), last.x, 1e-9);
    const b = path.bounds().?;
    // A clockwise (sweep) arc in y-down space bulges upward.
    try std.testing.expectApproxEqAbs(@as(f64, -5), b.min.y, 0.05);
}
