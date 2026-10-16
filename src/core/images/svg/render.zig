//! Renders a parsed SVG document onto a raster.
//!
//! Supported: shapes (rect, circle, ellipse, line, polyline, polygon,
//! path), groups, nested svg, use/symbol, linear and radial gradients,
//! markers, text/tspan (Hershey stroke font), transforms, viewBox and
//! preserveAspectRatio, presentation attributes, inline styles, and a CSS
//! subset in <style>. Clipping, masks, filters, patterns, and embedded
//! images are not drawn; their content renders unclipped or is skipped.

const std = @import("std");
const xml = @import("xml.zig");
const style = @import("style.zig");
const canvas = @import("canvas.zig");
const path_data = @import("path_data.zig");
const text_layout = @import("text.zig");
const raster_mod = @import("../raster.zig");

const Allocator = std.mem.Allocator;
const Transform = canvas.Transform;
const Point = canvas.Point;
const Node = xml.Node;

const black = style.Color{ .r = 0, .g = 0, .b = 0 };
const max_use_depth = 16;
const max_size: f64 = 8192;

pub const Size = struct { width: f64, height: f64 };

const ViewBox = struct { x: f64, y: f64, width: f64, height: f64 };

const TextAnchor = enum { start, middle, end };
const Baseline = enum { alphabetic, middle, hanging };

const Style = struct {
    fill: style.Paint = .{ .color = black },
    fill_opacity: f32 = 1,
    fill_rule: canvas.FillRule = .nonzero,
    stroke: style.Paint = .none,
    stroke_opacity: f32 = 1,
    stroke_width: f64 = 1,
    line_cap: canvas.LineCap = .butt,
    line_join: canvas.LineJoin = .miter,
    miter_limit: f64 = 4,
    dashes: []const f64 = &.{},
    dash_offset: f64 = 0,
    color: style.Color = black,
    font_size: f64 = 16,
    bold: bool = false,
    text_anchor: TextAnchor = .start,
    baseline: Baseline = .alphabetic,
    visible: bool = true,
    marker_start: ?[]const u8 = null,
    marker_mid: ?[]const u8 = null,
    marker_end: ?[]const u8 = null,
    // Not inherited:
    opacity: f32 = 1,
    display_none: bool = false,

    fn inherit(parent: Style) Style {
        var s = parent;
        s.opacity = 1;
        s.display_none = false;
        return s;
    }
};

pub const Renderer = struct {
    arena: Allocator,
    doc: *const xml.Document,
    canvas: *canvas.Canvas,
    rules: std.ArrayList(style.Rule) = .empty,
    viewport: Size,
    use_depth: usize = 0,

    pub fn init(arena: Allocator, doc: *const xml.Document, target: *canvas.Canvas, viewport: Size) !Renderer {
        var r = Renderer{ .arena = arena, .doc = doc, .canvas = target, .viewport = viewport };
        try r.collectStyles(doc.root);
        return r;
    }

    fn collectStyles(self: *Renderer, node: *const Node) !void {
        if (std.mem.eql(u8, node.name, "style")) try style.parseStylesheet(self.arena, node.text, &self.rules);
        for (node.children) |child| try self.collectStyles(child);
    }

    fn computeStyle(self: *Renderer, node: *const Node, parent: Style) !Style {
        var s = Style.inherit(parent);
        for (node.attributes) |a| try self.applyProperty(&s, a.name, a.value, parent);
        const id = node.attribute("id");
        const classes = node.attribute("class");
        for (self.rules.items) |rule| {
            if (!rule.selector.matches(node.name, id, classes)) continue;
            var it = style.DeclarationIterator{ .text = rule.declarations };
            while (it.next()) |d| try self.applyProperty(&s, d.property, d.value, parent);
        }
        if (node.attribute("style")) |inline_style| {
            var it = style.DeclarationIterator{ .text = inline_style };
            while (it.next()) |d| try self.applyProperty(&s, d.property, d.value, parent);
        }
        return s;
    }

    fn applyProperty(self: *Renderer, s: *Style, name: []const u8, raw: []const u8, parent: Style) !void {
        const value = std.mem.trim(u8, raw, " \t\r\n");
        if (std.mem.eql(u8, value, "inherit")) return;
        const eq = std.mem.eql;
        if (eq(u8, name, "fill")) {
            if (style.parsePaint(value)) |p| s.fill = p;
        } else if (eq(u8, name, "stroke")) {
            if (style.parsePaint(value)) |p| s.stroke = p;
        } else if (eq(u8, name, "color")) {
            if (style.parseColor(value)) |c| s.color = c;
        } else if (eq(u8, name, "fill-opacity")) {
            s.fill_opacity = parseOpacity(value) orelse s.fill_opacity;
        } else if (eq(u8, name, "stroke-opacity")) {
            s.stroke_opacity = parseOpacity(value) orelse s.stroke_opacity;
        } else if (eq(u8, name, "opacity")) {
            s.opacity = parseOpacity(value) orelse s.opacity;
        } else if (eq(u8, name, "fill-rule")) {
            s.fill_rule = if (eq(u8, value, "evenodd")) .evenodd else .nonzero;
        } else if (eq(u8, name, "stroke-width")) {
            if (style.parseLength(value, self.diagonal(), s.font_size)) |w| s.stroke_width = @max(w, 0);
        } else if (eq(u8, name, "stroke-linecap")) {
            s.line_cap = if (eq(u8, value, "round")) .round else if (eq(u8, value, "square")) .square else .butt;
        } else if (eq(u8, name, "stroke-linejoin")) {
            s.line_join = if (eq(u8, value, "round")) .round else if (eq(u8, value, "bevel")) .bevel else .miter;
        } else if (eq(u8, name, "stroke-miterlimit")) {
            s.miter_limit = std.fmt.parseFloat(f64, value) catch s.miter_limit;
        } else if (eq(u8, name, "stroke-dasharray")) {
            s.dashes = try self.parseNumberList(value, s.font_size);
        } else if (eq(u8, name, "stroke-dashoffset")) {
            s.dash_offset = style.parseLength(value, self.diagonal(), s.font_size) orelse 0;
        } else if (eq(u8, name, "font-size")) {
            s.font_size = parseFontSize(value, parent.font_size) orelse s.font_size;
        } else if (eq(u8, name, "font-weight")) {
            s.bold = eq(u8, value, "bold") or eq(u8, value, "bolder") or
                ((std.fmt.parseInt(u16, value, 10) catch 400) >= 600);
        } else if (eq(u8, name, "font")) {
            // Shorthand: pick out a size like "bold 14px sans-serif".
            var it = std.mem.tokenizeScalar(u8, value, ' ');
            while (it.next()) |part| {
                if (std.mem.eql(u8, part, "bold")) s.bold = true;
                if (parseFontSize(part, parent.font_size)) |size| s.font_size = size;
            }
        } else if (eq(u8, name, "text-anchor")) {
            s.text_anchor = if (eq(u8, value, "middle")) .middle else if (eq(u8, value, "end")) .end else .start;
        } else if (eq(u8, name, "dominant-baseline") or eq(u8, name, "alignment-baseline")) {
            s.baseline = if (eq(u8, value, "middle") or eq(u8, value, "central"))
                .middle
            else if (eq(u8, value, "hanging") or eq(u8, value, "text-before-edge"))
                .hanging
            else
                .alphabetic;
        } else if (eq(u8, name, "display")) {
            s.display_none = eq(u8, value, "none");
        } else if (eq(u8, name, "visibility")) {
            s.visible = !(eq(u8, value, "hidden") or eq(u8, value, "collapse"));
        } else if (eq(u8, name, "marker-start")) {
            s.marker_start = urlId(value);
        } else if (eq(u8, name, "marker-mid")) {
            s.marker_mid = urlId(value);
        } else if (eq(u8, name, "marker-end")) {
            s.marker_end = urlId(value);
        } else if (eq(u8, name, "marker")) {
            const id = urlId(value);
            s.marker_start = id;
            s.marker_mid = id;
            s.marker_end = id;
        }
    }

    fn diagonal(self: *const Renderer) f64 {
        return @sqrt((self.viewport.width * self.viewport.width + self.viewport.height * self.viewport.height) / 2);
    }

    fn parseNumberList(self: *Renderer, value: []const u8, font_size: f64) ![]const f64 {
        if (std.mem.eql(u8, value, "none")) return &.{};
        var list: std.ArrayList(f64) = .empty;
        var it = std.mem.tokenizeAny(u8, value, " ,\t\r\n");
        while (it.next()) |part| {
            const n = style.parseLength(part, self.diagonal(), font_size) orelse return &.{};
            if (n < 0) return &.{};
            try list.append(self.arena, n);
        }
        // An odd count repeats to make an even pattern.
        if (list.items.len % 2 == 1) try list.appendSlice(self.arena, try self.arena.dupe(f64, list.items));
        return list.items;
    }

    fn length(self: *const Renderer, node: *const Node, name: []const u8, axis: enum { x, y, diagonal }, s: Style, default: f64) f64 {
        const raw = node.attribute(name) orelse return default;
        // Lists (as in text x="1 2 3") use their first value here.
        var it = std.mem.tokenizeAny(u8, raw, " ,");
        const first = it.next() orelse return default;
        const base = switch (axis) {
            .x => self.viewport.width,
            .y => self.viewport.height,
            .diagonal => self.diagonal(),
        };
        return style.parseLength(first, base, s.font_size) orelse default;
    }

    pub fn renderNode(self: *Renderer, node: *const Node, ctm_in: Transform, parent: Style, alpha_in: f32) anyerror!void {
        if (std.mem.eql(u8, node.name, xml.text_node_name)) return;
        const s = try self.computeStyle(node, parent);
        if (s.display_none) return;
        const alpha = alpha_in * s.opacity;
        var ctm = ctm_in;
        if (node.attribute("transform")) |t| ctm = ctm.multiply(parseTransform(t));
        const name = node.name;
        const eq = std.mem.eql;

        if (eq(u8, name, "g") or eq(u8, name, "a")) {
            for (node.children) |child| try self.renderNode(child, ctm, s, alpha);
        } else if (eq(u8, name, "svg")) {
            try self.renderNestedSvg(node, ctm, s, alpha);
        } else if (eq(u8, name, "switch")) {
            for (node.children) |child| {
                if (eq(u8, child.name, xml.text_node_name)) continue;
                try self.renderNode(child, ctm, s, alpha);
                break;
            }
        } else if (eq(u8, name, "use")) {
            try self.renderUse(node, ctm, s, alpha);
        } else if (eq(u8, name, "text")) {
            try self.renderText(node, ctm, s, alpha);
        } else if (isShape(name)) {
            try self.renderShape(node, ctm, s, alpha);
        }
        // defs, symbol, marker, gradients, style, title, desc, metadata,
        // clipPath, mask, filter, pattern, and image draw nothing directly.
    }

    fn renderNestedSvg(self: *Renderer, node: *const Node, ctm: Transform, s: Style, alpha: f32) !void {
        const saved = self.viewport;
        defer self.viewport = saved;
        const x = self.length(node, "x", .x, s, 0);
        const y = self.length(node, "y", .y, s, 0);
        const w = self.length(node, "width", .x, s, self.viewport.width);
        const h = self.length(node, "height", .y, s, self.viewport.height);
        var inner = ctm.multiply(Transform.translate(x, y));
        if (parseViewBox(node.attribute("viewBox"))) |vb| {
            inner = inner.multiply(viewBoxTransform(vb, w, h, node.attribute("preserveAspectRatio")));
            self.viewport = .{ .width = vb.width, .height = vb.height };
        } else {
            self.viewport = .{ .width = w, .height = h };
        }
        for (node.children) |child| try self.renderNode(child, inner, s, alpha);
    }

    fn renderUse(self: *Renderer, node: *const Node, ctm: Transform, s: Style, alpha: f32) !void {
        if (self.use_depth >= max_use_depth) return;
        const href = node.attribute("href") orelse return;
        if (href.len < 2 or href[0] != '#') return;
        const target = self.doc.findById(href[1..]) orelse return;
        // A use that reaches its own ancestor would recurse forever.
        var ancestor: ?*Node = node.parent;
        while (ancestor) |a| : (ancestor = a.parent) if (a == target) return;
        self.use_depth += 1;
        defer self.use_depth -= 1;
        const x = self.length(node, "x", .x, s, 0);
        const y = self.length(node, "y", .y, s, 0);
        const placed = ctm.multiply(Transform.translate(x, y));
        if (std.mem.eql(u8, target.name, "symbol")) {
            const symbol_style = try self.computeStyle(target, s);
            var inner = placed;
            if (parseViewBox(target.attribute("viewBox"))) |vb| {
                const w = self.length(node, "width", .x, s, vb.width);
                const h = self.length(node, "height", .y, s, vb.height);
                inner = inner.multiply(viewBoxTransform(vb, w, h, target.attribute("preserveAspectRatio")));
            }
            for (target.children) |child| try self.renderNode(child, inner, symbol_style, alpha);
            return;
        }
        try self.renderNode(target, placed, s, alpha);
    }

    fn tolerance(ctm: Transform) f64 {
        const scale = ctm.meanScale();
        return if (scale > 0) 0.2 / scale else 0.2;
    }

    fn buildShape(self: *Renderer, node: *const Node, s: Style, path: *canvas.Path) !void {
        const eq = std.mem.eql;
        const name = node.name;
        if (eq(u8, name, "path")) {
            try path_data.build(path, node.attribute("d") orelse "");
        } else if (eq(u8, name, "rect")) {
            const x = self.length(node, "x", .x, s, 0);
            const y = self.length(node, "y", .y, s, 0);
            const w = self.length(node, "width", .x, s, 0);
            const h = self.length(node, "height", .y, s, 0);
            if (!(w > 0 and h > 0)) return;
            var rx = self.length(node, "rx", .x, s, -1);
            var ry = self.length(node, "ry", .y, s, -1);
            if (rx < 0) rx = ry;
            if (ry < 0) ry = rx;
            rx = std.math.clamp(rx, 0, w / 2);
            ry = std.math.clamp(ry, 0, h / 2);
            if (rx <= 0 or ry <= 0) {
                try path.moveTo(.{ .x = x, .y = y });
                try path.lineTo(.{ .x = x + w, .y = y });
                try path.lineTo(.{ .x = x + w, .y = y + h });
                try path.lineTo(.{ .x = x, .y = y + h });
            } else {
                try path.moveTo(.{ .x = x + rx, .y = y });
                try path.lineTo(.{ .x = x + w - rx, .y = y });
                try path.arcTo(rx, ry, 0, false, true, .{ .x = x + w, .y = y + ry });
                try path.lineTo(.{ .x = x + w, .y = y + h - ry });
                try path.arcTo(rx, ry, 0, false, true, .{ .x = x + w - rx, .y = y + h });
                try path.lineTo(.{ .x = x + rx, .y = y + h });
                try path.arcTo(rx, ry, 0, false, true, .{ .x = x, .y = y + h - ry });
                try path.lineTo(.{ .x = x, .y = y + ry });
                try path.arcTo(rx, ry, 0, false, true, .{ .x = x + rx, .y = y });
            }
            path.close();
        } else if (eq(u8, name, "circle")) {
            const r = self.length(node, "r", .diagonal, s, 0);
            if (r > 0) try path.ellipse(self.length(node, "cx", .x, s, 0), self.length(node, "cy", .y, s, 0), r, r);
        } else if (eq(u8, name, "ellipse")) {
            var rx = self.length(node, "rx", .x, s, -1);
            var ry = self.length(node, "ry", .y, s, -1);
            if (rx < 0) rx = ry;
            if (ry < 0) ry = rx;
            if (rx > 0 and ry > 0) try path.ellipse(self.length(node, "cx", .x, s, 0), self.length(node, "cy", .y, s, 0), rx, ry);
        } else if (eq(u8, name, "line")) {
            try path.moveTo(.{ .x = self.length(node, "x1", .x, s, 0), .y = self.length(node, "y1", .y, s, 0) });
            try path.lineTo(.{ .x = self.length(node, "x2", .x, s, 0), .y = self.length(node, "y2", .y, s, 0) });
        } else if (eq(u8, name, "polyline") or eq(u8, name, "polygon")) {
            var it = std.mem.tokenizeAny(u8, node.attribute("points") orelse "", " ,\t\r\n");
            var first = true;
            while (it.next()) |xs| {
                const ys = it.next() orelse break;
                const p = Point{
                    .x = std.fmt.parseFloat(f64, xs) catch break,
                    .y = std.fmt.parseFloat(f64, ys) catch break,
                };
                if (first) try path.moveTo(p) else try path.lineTo(p);
                first = false;
            }
            if (eq(u8, name, "polygon")) path.close();
        }
    }

    fn renderShape(self: *Renderer, node: *const Node, ctm: Transform, s: Style, alpha: f32) !void {
        if (!s.visible) return;
        var path = canvas.Path.init(self.arena, tolerance(ctm));
        try self.buildShape(node, s, &path);
        if (path.contours.items.len == 0) return;
        const is_line = std.mem.eql(u8, node.name, "line");
        if (!is_line) {
            if (try self.resolvePaint(s.fill, s, s.fill_opacity * alpha, &path, ctm)) |paint| {
                try self.canvas.fillPath(&path, ctm, s.fill_rule, paint);
            }
        }
        if (s.stroke_width > 0) {
            if (try self.resolvePaint(s.stroke, s, s.stroke_opacity * alpha, &path, ctm)) |paint| {
                try self.canvas.strokePath(&path, ctm, .{
                    .width = s.stroke_width,
                    .join = s.line_join,
                    .cap = s.line_cap,
                    .miter_limit = s.miter_limit,
                    .dashes = s.dashes,
                    .dash_offset = s.dash_offset,
                }, paint);
            }
        }
        if (s.marker_start != null or s.marker_mid != null or s.marker_end != null) try self.renderMarkers(&path, ctm, s, alpha);
    }

    fn resolvePaint(self: *Renderer, paint: style.Paint, s: Style, opacity: f32, path: *const canvas.Path, ctm: Transform) !?canvas.Paint {
        switch (paint) {
            .none => return null,
            .color => |c| return solid(c, opacity),
            .current_color => return solid(s.color, opacity),
            .reference => |ref| {
                if (self.doc.findById(ref.id)) |node| {
                    if (try self.buildGradient(node, opacity, path, ctm)) |g| return g;
                }
                return if (ref.fallback) |c| solid(c, opacity) else null;
            },
        }
    }

    fn buildGradient(self: *Renderer, node: *const Node, opacity: f32, path: *const canvas.Path, ctm: Transform) !?canvas.Paint {
        const linear = std.mem.eql(u8, node.name, "linearGradient");
        if (!linear and !std.mem.eql(u8, node.name, "radialGradient")) return null;
        // Stops and unspecified attributes may come from an href'd gradient.
        var stops_node = node;
        if (node.attribute("href")) |href| {
            if (href.len > 1 and href[0] == '#' and !hasStops(node)) {
                if (self.doc.findById(href[1..])) |other| stops_node = other;
            }
        }
        var stops: std.ArrayList(canvas.GradientStop) = .empty;
        var last_offset: f32 = 0;
        for (stops_node.children) |child| {
            if (!std.mem.eql(u8, child.name, "stop")) continue;
            const stop_style = try self.computeStyle(child, .{});
            var color = black;
            var stop_opacity: f32 = 1;
            if (child.attribute("stop-color")) |v| color = style.parseColor(v) orelse color;
            if (child.attribute("stop-opacity")) |v| stop_opacity = parseOpacity(v) orelse 1;
            if (child.attribute("style")) |inline_style| {
                var it = style.DeclarationIterator{ .text = inline_style };
                while (it.next()) |d| {
                    if (std.mem.eql(u8, d.property, "stop-color")) color = style.parseColor(d.value) orelse color;
                    if (std.mem.eql(u8, d.property, "stop-opacity")) stop_opacity = parseOpacity(d.value) orelse 1;
                }
            }
            _ = stop_style;
            var offset: f32 = parseOpacity(child.attribute("offset") orelse "0") orelse 0;
            offset = @max(offset, last_offset);
            last_offset = offset;
            try stops.append(self.arena, .{ .offset = offset, .color = .{
                .r = @as(f32, @floatFromInt(color.r)) / 255,
                .g = @as(f32, @floatFromInt(color.g)) / 255,
                .b = @as(f32, @floatFromInt(color.b)) / 255,
                .a = color.a * stop_opacity,
            } });
        }
        if (stops.items.len == 0) return null;
        if (stops.items.len == 1) return .{ .solid = stops.items[0].color };

        const user_space = if (node.attribute("gradientUnits")) |u| std.mem.eql(u8, u, "userSpaceOnUse") else false;
        var space = ctm;
        if (!user_space) {
            const b = path.bounds() orelse return null;
            const w = b.max.x - b.min.x;
            const h = b.max.y - b.min.y;
            if (w <= 0 or h <= 0) return null;
            space = space.multiply(Transform.translate(b.min.x, b.min.y)).multiply(Transform.scaling(w, h));
        }
        if (node.attribute("gradientTransform")) |t| space = space.multiply(parseTransform(t));
        const inverse = space.invert() orelse return null;
        const unit_base: Size = if (user_space) self.viewport else .{ .width = 1, .height = 1 };
        const g = try self.arena.create(canvas.Gradient);
        const fraction = struct {
            fn get(n: *const Node, name: []const u8, base: f64, default: f64) f64 {
                const raw = n.attribute(name) orelse return default;
                return style.parseLength(raw, base, 16) orelse default;
            }
        }.get;
        const spread_attr = node.attribute("spreadMethod") orelse "pad";
        g.* = .{
            .kind = if (linear) .linear else .radial,
            .inverse = inverse,
            .x1 = if (linear) fraction(node, "x1", unit_base.width, 0) else fraction(node, "cx", unit_base.width, 0.5 * unit_base.width),
            .y1 = if (linear) fraction(node, "y1", unit_base.height, 0) else fraction(node, "cy", unit_base.height, 0.5 * unit_base.height),
            .x2 = if (linear) fraction(node, "x2", unit_base.width, unit_base.width) else fraction(node, "r", @sqrt((unit_base.width * unit_base.width + unit_base.height * unit_base.height) / 2), 0.5 * unit_base.width),
            .y2 = if (linear) fraction(node, "y2", unit_base.height, 0) else 0,
            .stops = stops.items,
            .spread = if (std.mem.eql(u8, spread_attr, "reflect")) .reflect else if (std.mem.eql(u8, spread_attr, "repeat")) .repeat else .pad,
            .opacity = opacity,
        };
        return .{ .gradient = g };
    }

    fn renderMarkers(self: *Renderer, path: *const canvas.Path, ctm: Transform, s: Style, alpha: f32) !void {
        for (path.contours.items) |contour| {
            const pts = contour.points.items;
            if (pts.len < 2) continue;
            if (s.marker_start) |id| try self.drawMarker(id, pts[0], direction(pts[0], pts[1]), ctm, s, alpha, true);
            if (s.marker_mid) |id| {
                for (pts[1 .. pts.len - 1], 1..) |p, i| {
                    const into = direction(pts[i - 1], p);
                    const out = direction(p, pts[i + 1]);
                    try self.drawMarker(id, p, std.math.atan2(@sin(into) + @sin(out), @cos(into) + @cos(out)), ctm, s, alpha, false);
                }
            }
            if (s.marker_end) |id| try self.drawMarker(id, pts[pts.len - 1], direction(pts[pts.len - 2], pts[pts.len - 1]), ctm, s, alpha, false);
        }
    }

    fn drawMarker(self: *Renderer, id: []const u8, at: Point, angle: f64, ctm: Transform, s: Style, alpha: f32, is_start: bool) !void {
        const marker = self.doc.findById(id) orelse return;
        if (!std.mem.eql(u8, marker.name, "marker")) return;
        if (self.use_depth >= max_use_depth) return;
        self.use_depth += 1;
        defer self.use_depth -= 1;
        const marker_style = try self.computeStyle(marker, .{});
        var t = ctm.multiply(Transform.translate(at.x, at.y));
        const orient = marker.attribute("orient") orelse "0";
        if (std.mem.eql(u8, orient, "auto")) {
            t = t.multiply(Transform.rotation(angle * 180 / std.math.pi));
        } else if (std.mem.eql(u8, orient, "auto-start-reverse")) {
            t = t.multiply(Transform.rotation(angle * 180 / std.math.pi + if (is_start) @as(f64, 180) else 0));
        } else {
            t = t.multiply(Transform.rotation(std.fmt.parseFloat(f64, orient) catch 0));
        }
        const units = marker.attribute("markerUnits") orelse "strokeWidth";
        if (std.mem.eql(u8, units, "strokeWidth")) t = t.multiply(Transform.scaling(s.stroke_width, s.stroke_width));
        const mw = self.length(marker, "markerWidth", .x, marker_style, 3);
        const mh = self.length(marker, "markerHeight", .y, marker_style, 3);
        if (parseViewBox(marker.attribute("viewBox"))) |vb| {
            t = t.multiply(viewBoxTransform(vb, mw, mh, marker.attribute("preserveAspectRatio")));
        }
        const ref_x = std.fmt.parseFloat(f64, marker.attribute("refX") orelse "0") catch 0;
        const ref_y = std.fmt.parseFloat(f64, marker.attribute("refY") orelse "0") catch 0;
        t = t.multiply(Transform.translate(-ref_x, -ref_y));
        for (marker.children) |child| try self.renderNode(child, t, marker_style, alpha);
    }

    const TextRun = struct {
        text: []const u8,
        s: Style,
        x: ?f64,
        y: ?f64,
        dx: f64,
        dy: f64,
    };

    fn collectText(self: *Renderer, node: *const Node, s: Style, runs: *std.ArrayList(TextRun), is_root: bool) !void {
        var pending_x: ?f64 = null;
        var pending_y: ?f64 = null;
        var pending_dx: f64 = 0;
        var pending_dy: f64 = 0;
        if (!is_root) {
            if (node.attribute("x") != null) pending_x = self.length(node, "x", .x, s, 0);
            if (node.attribute("y") != null) pending_y = self.length(node, "y", .y, s, 0);
            pending_dx = self.length(node, "dx", .x, s, 0);
            pending_dy = self.length(node, "dy", .y, s, 0);
        }
        for (node.children) |child| {
            if (std.mem.eql(u8, child.name, xml.text_node_name)) {
                try runs.append(self.arena, .{ .text = child.text, .s = s, .x = pending_x, .y = pending_y, .dx = pending_dx, .dy = pending_dy });
                pending_x = null;
                pending_y = null;
                pending_dx = 0;
                pending_dy = 0;
            } else if (std.mem.eql(u8, child.name, "tspan") or std.mem.eql(u8, child.name, "a") or std.mem.eql(u8, child.name, "textPath")) {
                const child_style = try self.computeStyle(child, s);
                if (child_style.display_none) continue;
                const before = runs.items.len;
                try self.collectText(child, child_style, runs, false);
                // Positioning on an element with no text applies to what follows.
                if (runs.items.len > before) {
                    const first = &runs.items[before];
                    if (first.x == null) first.x = pending_x;
                    if (first.y == null) first.y = pending_y;
                    first.dx += pending_dx;
                    first.dy += pending_dy;
                    pending_x = null;
                    pending_y = null;
                    pending_dx = 0;
                    pending_dy = 0;
                }
            }
        }
    }

    fn renderText(self: *Renderer, node: *const Node, ctm: Transform, s: Style, alpha: f32) !void {
        var runs: std.ArrayList(TextRun) = .empty;
        try self.collectText(node, s, &runs, true);
        if (runs.items.len == 0) return;
        if (runs.items[0].x == null) runs.items[0].x = self.length(node, "x", .x, s, 0);
        if (runs.items[0].y == null) runs.items[0].y = self.length(node, "y", .y, s, 0);
        runs.items[0].dx += self.length(node, "dx", .x, s, 0);
        runs.items[0].dy += self.length(node, "dy", .y, s, 0);

        // Collapse whitespace as with xml:space="default".
        for (runs.items, 0..) |*run, i| {
            run.text = try collapseWhitespace(self.arena, run.text, i == 0, i == runs.items.len - 1);
        }

        var pen = Point{ .x = 0, .y = 0 };
        var chunk_start: usize = 0;
        while (chunk_start < runs.items.len) {
            // A chunk runs until the next absolute x position.
            var chunk_end = chunk_start + 1;
            while (chunk_end < runs.items.len and runs.items[chunk_end].x == null) chunk_end += 1;
            var width: f64 = 0;
            for (runs.items[chunk_start..chunk_end]) |run| width += text_layout.measure(run.text, run.s.font_size) + run.dx;
            const anchor = runs.items[chunk_start].s.text_anchor;
            const shift: f64 = switch (anchor) {
                .start => 0,
                .middle => -width / 2,
                .end => -width,
            };
            for (runs.items[chunk_start..chunk_end], chunk_start..) |run, i| {
                if (run.x) |x| pen.x = x + (if (i == chunk_start) shift else 0);
                if (run.y) |y| pen.y = y;
                pen.x += run.dx;
                pen.y += run.dy;
                if (!run.s.visible or run.text.len == 0) {
                    pen.x += text_layout.measure(run.text, run.s.font_size);
                    continue;
                }
                const baseline_offset: f64 = switch (run.s.baseline) {
                    .alphabetic => 0,
                    .middle => text_layout.capHeight(run.s.font_size) / 2,
                    .hanging => text_layout.capHeight(run.s.font_size),
                };
                var path = canvas.Path.init(self.arena, tolerance(ctm));
                const advance = try text_layout.appendStrokes(&path, run.text, pen.x, pen.y + baseline_offset, run.s.font_size);
                // Single-line glyphs are drawn with the text's fill paint.
                const paint_source = if (run.s.fill != .none) run.s.fill else run.s.stroke;
                const opacity = (if (run.s.fill != .none) run.s.fill_opacity else run.s.stroke_opacity) * alpha;
                if (try self.resolvePaint(paint_source, run.s, opacity, &path, ctm)) |paint| {
                    try self.canvas.strokePath(&path, ctm, .{
                        .width = text_layout.strokeWidth(run.s.font_size, run.s.bold),
                        .join = .round,
                        .cap = .round,
                    }, paint);
                }
                pen.x += advance;
            }
            chunk_start = chunk_end;
        }
    }
};

fn isShape(name: []const u8) bool {
    const shapes = [_][]const u8{ "path", "rect", "circle", "ellipse", "line", "polyline", "polygon" };
    for (shapes) |shape| if (std.mem.eql(u8, name, shape)) return true;
    return false;
}

fn hasStops(node: *const Node) bool {
    for (node.children) |child| if (std.mem.eql(u8, child.name, "stop")) return true;
    return false;
}

fn direction(a: Point, b: Point) f64 {
    return std.math.atan2(b.y - a.y, b.x - a.x);
}

fn solid(c: style.Color, opacity: f32) canvas.Paint {
    return .{ .solid = .{
        .r = @as(f32, @floatFromInt(c.r)) / 255,
        .g = @as(f32, @floatFromInt(c.g)) / 255,
        .b = @as(f32, @floatFromInt(c.b)) / 255,
        .a = c.a * opacity,
    } };
}

fn parseOpacity(value: []const u8) ?f32 {
    const v = std.mem.trim(u8, value, " ");
    if (std.mem.endsWith(u8, v, "%")) {
        const n = std.fmt.parseFloat(f32, v[0 .. v.len - 1]) catch return null;
        return std.math.clamp(n / 100, 0, 1);
    }
    const n = std.fmt.parseFloat(f32, v) catch return null;
    return std.math.clamp(n, 0, 1);
}

fn parseFontSize(value: []const u8, parent_size: f64) ?f64 {
    const keywords = [_]struct { []const u8, f64 }{
        .{ "xx-small", 9 }, .{ "x-small", 10 }, .{ "small", 13 },    .{ "medium", 16 },
        .{ "large", 18 },   .{ "x-large", 24 }, .{ "xx-large", 32 },
    };
    for (keywords) |k| if (std.mem.eql(u8, value, k[0])) return k[1];
    const size = style.parseLength(value, parent_size, parent_size) orelse return null;
    return if (size > 0 and size < 10_000) size else null;
}

fn urlId(value: []const u8) ?[]const u8 {
    const paint = style.parsePaint(value) orelse return null;
    return switch (paint) {
        .reference => |r| r.id,
        else => null,
    };
}

fn collapseWhitespace(alloc: Allocator, text: []const u8, trim_start: bool, trim_end: bool) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var previous_space = trim_start;
    for (text) |c| {
        if (std.ascii.isWhitespace(c)) {
            if (!previous_space) try out.append(alloc, ' ');
            previous_space = true;
        } else {
            try out.append(alloc, c);
            previous_space = false;
        }
    }
    if (trim_end and out.items.len > 0 and out.items[out.items.len - 1] == ' ') _ = out.pop();
    return out.items;
}

pub fn parseTransform(text: []const u8) Transform {
    var result = Transform.identity;
    var pos: usize = 0;
    while (pos < text.len) {
        while (pos < text.len and (std.ascii.isWhitespace(text[pos]) or text[pos] == ',')) pos += 1;
        const name_start = pos;
        while (pos < text.len and std.ascii.isAlphabetic(text[pos])) pos += 1;
        const name = text[name_start..pos];
        while (pos < text.len and std.ascii.isWhitespace(text[pos])) pos += 1;
        if (pos >= text.len or text[pos] != '(') break;
        const close = std.mem.indexOfScalarPos(u8, text, pos, ')') orelse break;
        var args: [6]f64 = @splat(0);
        var count: usize = 0;
        var it = std.mem.tokenizeAny(u8, text[pos + 1 .. close], " ,\t\r\n");
        while (it.next()) |arg| {
            if (count == args.len) break;
            args[count] = std.fmt.parseFloat(f64, arg) catch 0;
            count += 1;
        }
        pos = close + 1;
        const t: Transform = if (std.mem.eql(u8, name, "matrix") and count == 6)
            .{ .a = args[0], .b = args[1], .c = args[2], .d = args[3], .e = args[4], .f = args[5] }
        else if (std.mem.eql(u8, name, "translate"))
            Transform.translate(args[0], if (count > 1) args[1] else 0)
        else if (std.mem.eql(u8, name, "scale"))
            Transform.scaling(args[0], if (count > 1) args[1] else args[0])
        else if (std.mem.eql(u8, name, "rotate"))
            if (count >= 3)
                Transform.translate(args[1], args[2]).multiply(Transform.rotation(args[0])).multiply(Transform.translate(-args[1], -args[2]))
            else
                Transform.rotation(args[0])
        else if (std.mem.eql(u8, name, "skewX"))
            .{ .c = @tan(args[0] * std.math.pi / 180) }
        else if (std.mem.eql(u8, name, "skewY"))
            .{ .b = @tan(args[0] * std.math.pi / 180) }
        else
            Transform.identity;
        result = result.multiply(t);
    }
    return result;
}

fn parseViewBox(value: ?[]const u8) ?ViewBox {
    var it = std.mem.tokenizeAny(u8, value orelse return null, " ,\t\r\n");
    var v: [4]f64 = undefined;
    for (&v) |*n| n.* = std.fmt.parseFloat(f64, it.next() orelse return null) catch return null;
    if (!(v[2] > 0 and v[3] > 0)) return null;
    return .{ .x = v[0], .y = v[1], .width = v[2], .height = v[3] };
}

fn viewBoxTransform(vb: ViewBox, width: f64, height: f64, aspect: ?[]const u8) Transform {
    const par = std.mem.trim(u8, aspect orelse "xMidYMid meet", " ");
    var sx = width / vb.width;
    var sy = height / vb.height;
    if (!std.mem.startsWith(u8, par, "none")) {
        const slice = std.mem.indexOf(u8, par, "slice") != null;
        const s = if (slice) @max(sx, sy) else @min(sx, sy);
        sx = s;
        sy = s;
    }
    var tx = -vb.x * sx;
    var ty = -vb.y * sy;
    const extra_w = width - vb.width * sx;
    const extra_h = height - vb.height * sy;
    if (std.mem.indexOf(u8, par, "xMid") != null) tx += extra_w / 2;
    if (std.mem.indexOf(u8, par, "xMax") != null) tx += extra_w;
    if (std.mem.indexOf(u8, par, "YMid") != null) ty += extra_h / 2;
    if (std.mem.indexOf(u8, par, "YMax") != null) ty += extra_h;
    return .{ .a = sx, .d = sy, .e = tx, .f = ty };
}

/// The document's natural size in CSS pixels.
pub fn documentSize(root: *const Node) Size {
    const vb = parseViewBox(root.attribute("viewBox"));
    const width = absoluteLength(root.attribute("width"));
    const height = absoluteLength(root.attribute("height"));
    var size: Size = if (width != null and height != null)
        .{ .width = width.?, .height = height.? }
    else if (vb) |v|
        if (width) |w|
            .{ .width = w, .height = w * v.height / v.width }
        else if (height) |h|
            .{ .width = h * v.width / v.height, .height = h }
        else
            .{ .width = v.width, .height = v.height }
    else
        .{ .width = width orelse 300, .height = height orelse 150 };
    if (!(size.width > 0)) size.width = 300;
    if (!(size.height > 0)) size.height = 150;
    size.width = @min(size.width, max_size);
    size.height = @min(size.height, max_size);
    return size;
}

fn absoluteLength(value: ?[]const u8) ?f64 {
    const v = value orelse return null;
    if (std.mem.indexOfScalar(u8, v, '%') != null) return null;
    const n = style.parseLength(v, 0, 16) orelse return null;
    return if (n > 0) n else null;
}

/// Renders `doc` scaled by `scale` onto a new transparent raster.
pub fn render(gpa: Allocator, doc: *const xml.Document, scale: f64) !raster_mod.Raster {
    if (!std.mem.eql(u8, doc.root.name, "svg")) return error.InvalidSvg;
    const size = documentSize(doc.root);
    const width: u32 = @intFromFloat(@max(1, @round(size.width * scale)));
    const height: u32 = @intFromFloat(@max(1, @round(size.height * scale)));
    var image = try raster_mod.Raster.init(gpa, width, height);
    errdefer image.deinit(gpa);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var target = canvas.Canvas.init(gpa, &image);
    var ctm = Transform.scaling(scale, scale);
    var viewport = size;
    if (parseViewBox(doc.root.attribute("viewBox"))) |vb| {
        ctm = ctm.multiply(viewBoxTransform(vb, size.width, size.height, doc.root.attribute("preserveAspectRatio")));
        viewport = .{ .width = vb.width, .height = vb.height };
    }
    var renderer = try Renderer.init(arena.allocator(), doc, &target, viewport);
    const root_style = try renderer.computeStyle(doc.root, .{});
    for (doc.root.children) |child| try renderer.renderNode(child, ctm, root_style, root_style.opacity);
    return image;
}

fn renderForTest(markup: []const u8, scale: f64) !raster_mod.Raster {
    var doc = try xml.parse(std.testing.allocator, markup);
    defer doc.deinit();
    return render(std.testing.allocator, &doc, scale);
}

test "renders shapes with fills, strokes, and viewBox scaling" {
    var image = try renderForTest(
        \\<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 40 20">
        \\  <rect x="0" y="0" width="20" height="20" fill="red"/>
        \\  <circle cx="30" cy="10" r="8" fill="none" stroke="#00f" stroke-width="2"/>
        \\</svg>
    , 1);
    defer image.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(u32, 20), image.width);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, image.pixel(5, 5).*);
    try std.testing.expectEqual(@as(u8, 0), image.pixel(15, 5)[3]); // inside the stroked ring
    try std.testing.expect(image.pixel(11, 5)[2] > 150); // the ring itself
}

test "styles cascade from stylesheet, attributes, inline, and groups" {
    var image = try renderForTest(
        \\<svg width="30" height="10">
        \\  <style>.a { fill: #0f0 } #b { fill: blue }</style>
        \\  <g fill="red"><rect width="10" height="10"/></g>
        \\  <rect class="a" x="10" width="10" height="10" fill="red"/>
        \\  <rect id="b" x="20" width="10" height="10" style="fill: yellow"/>
        \\</svg>
    , 1);
    defer image.deinit(std.testing.allocator);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, image.pixel(5, 5).*);
    try std.testing.expectEqual([4]u8{ 0, 255, 0, 255 }, image.pixel(15, 5).*);
    try std.testing.expectEqual([4]u8{ 255, 255, 0, 255 }, image.pixel(25, 5).*);
}

test "gradients, use references, and transforms" {
    var image = try renderForTest(
        \\<svg width="40" height="10" xmlns:xlink="http://www.w3.org/1999/xlink">
        \\  <defs>
        \\    <linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
        \\    <rect id="box" width="10" height="10" fill="#f0f"/>
        \\  </defs>
        \\  <rect width="20" height="10" fill="url(#g)"/>
        \\  <use xlink:href="#box" x="20"/>
        \\  <rect width="5" height="5" fill="#0ff" transform="translate(30 0) scale(2)"/>
        \\</svg>
    , 1);
    defer image.deinit(std.testing.allocator);
    try std.testing.expect(image.pixel(1, 5)[0] < 30);
    try std.testing.expect(image.pixel(18, 5)[0] > 220);
    try std.testing.expectEqual([4]u8{ 255, 0, 255, 255 }, image.pixel(25, 5).*);
    try std.testing.expectEqual([4]u8{ 0, 255, 255, 255 }, image.pixel(35, 5).*);
}

test "text draws strokes near its anchor and markers draw at line ends" {
    var image = try renderForTest(
        \\<svg width="200" height="40">
        \\  <defs><marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2"><rect width="4" height="4" fill="red"/></marker></defs>
        \\  <text x="100" y="30" font-size="20" text-anchor="middle">Hi</text>
        \\  <line x1="10" y1="5" x2="50" y2="5" stroke="black" marker-end="url(#m)"/>
        \\</svg>
    , 1);
    defer image.deinit(std.testing.allocator);
    var ink_left: u32 = 200;
    var ink_right: u32 = 0;
    var y: u32 = 10;
    while (y < 31) : (y += 1) {
        var x: u32 = 0;
        while (x < 200) : (x += 1) {
            if (image.pixel(x, y)[3] > 128) {
                ink_left = @min(ink_left, x);
                ink_right = @max(ink_right, x);
            }
        }
    }
    try std.testing.expect(ink_left > 80 and ink_right < 120 and ink_left < 100 and ink_right > 100);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, image.pixel(51, 5).*);
}

test "documentSize derives missing dimensions from the viewBox" {
    var doc = try xml.parse(std.testing.allocator, "<svg viewBox='0 0 400 200' width='100'/>");
    defer doc.deinit();
    const size = documentSize(doc.root);
    try std.testing.expectEqual(@as(f64, 100), size.width);
    try std.testing.expectEqual(@as(f64, 50), size.height);
}
