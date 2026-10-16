//! SVG presentation values: colors, lengths, declarations, and a small CSS
//! subset (type, class, id, and compound selectors, comma lists) for
//! `<style>` elements.

const std = @import("std");

const Allocator = std.mem.Allocator;

pub const Color = struct {
    r: u8,
    g: u8,
    b: u8,
    a: f32 = 1,
};

pub const Paint = union(enum) {
    none,
    color: Color,
    current_color,
    /// `url(#id)`, with the color to use when the reference is unusable.
    reference: struct { id: []const u8, fallback: ?Color },
};

pub fn parsePaint(raw: []const u8) ?Paint {
    const value = std.mem.trim(u8, raw, " \t\r\n");
    if (value.len == 0) return null;
    if (std.ascii.eqlIgnoreCase(value, "none")) return .none;
    if (std.ascii.eqlIgnoreCase(value, "currentColor")) return .current_color;
    if (startsWithIgnoreCase(value, "url(")) {
        const close = std.mem.indexOfScalar(u8, value, ')') orelse return null;
        var id = std.mem.trim(u8, value[4..close], " \t'\"");
        if (id.len > 0 and id[0] == '#') id = id[1..];
        return .{ .reference = .{ .id = id, .fallback = parseColor(value[close + 1 ..]) } };
    }
    return if (parseColor(value)) |c| .{ .color = c } else null;
}

pub fn parseColor(raw: []const u8) ?Color {
    const value = std.mem.trim(u8, raw, " \t\r\n");
    if (value.len == 0) return null;
    if (value[0] == '#') return parseHex(value[1..]);
    if (std.ascii.eqlIgnoreCase(value, "transparent")) return .{ .r = 0, .g = 0, .b = 0, .a = 0 };
    if (startsWithIgnoreCase(value, "rgb")) return parseRgbFunction(value);
    if (startsWithIgnoreCase(value, "hsl")) return parseHslFunction(value);
    return namedColor(value);
}

fn parseHex(hex: []const u8) ?Color {
    var digits: [8]u8 = undefined;
    for (hex, 0..) |c, i| {
        if (i >= digits.len) return null;
        digits[i] = std.fmt.charToDigit(c, 16) catch return null;
    }
    return switch (hex.len) {
        3, 4 => .{
            .r = digits[0] * 17,
            .g = digits[1] * 17,
            .b = digits[2] * 17,
            .a = if (hex.len == 4) @as(f32, @floatFromInt(digits[3] * 17)) / 255 else 1,
        },
        6, 8 => .{
            .r = digits[0] * 16 + digits[1],
            .g = digits[2] * 16 + digits[3],
            .b = digits[4] * 16 + digits[5],
            .a = if (hex.len == 8) @as(f32, @floatFromInt(digits[6] * 16 + digits[7])) / 255 else 1,
        },
        else => null,
    };
}

fn functionArguments(value: []const u8, out: *[4][]const u8) ?usize {
    const open = std.mem.indexOfScalar(u8, value, '(') orelse return null;
    const close = std.mem.lastIndexOfScalar(u8, value, ')') orelse return null;
    if (close < open) return null;
    var count: usize = 0;
    var it = std.mem.tokenizeAny(u8, value[open + 1 .. close], " ,/\t");
    while (it.next()) |arg| {
        if (count == out.len) return null;
        out[count] = arg;
        count += 1;
    }
    return count;
}

fn parseComponent(arg: []const u8, scale: f32) ?f32 {
    if (std.mem.endsWith(u8, arg, "%")) {
        const v = std.fmt.parseFloat(f32, arg[0 .. arg.len - 1]) catch return null;
        return v / 100 * scale;
    }
    return std.fmt.parseFloat(f32, arg) catch null;
}

fn parseRgbFunction(value: []const u8) ?Color {
    var args: [4][]const u8 = undefined;
    const n = functionArguments(value, &args) orelse return null;
    if (n < 3) return null;
    var rgb: [3]u8 = undefined;
    for (0..3) |i| rgb[i] = toByte(parseComponent(args[i], 255) orelse return null);
    const alpha = if (n == 4) parseComponent(args[3], 1) orelse return null else 1;
    return .{ .r = rgb[0], .g = rgb[1], .b = rgb[2], .a = std.math.clamp(alpha, 0, 1) };
}

fn parseHslFunction(value: []const u8) ?Color {
    var args: [4][]const u8 = undefined;
    const n = functionArguments(value, &args) orelse return null;
    if (n < 3) return null;
    const hue_text = std.mem.trimEnd(u8, args[0], "deg");
    const h = @mod((std.fmt.parseFloat(f32, hue_text) catch return null) / 360.0, 1.0);
    const s = std.math.clamp((parseComponent(args[1], 1) orelse return null), 0, 1);
    const l = std.math.clamp((parseComponent(args[2], 1) orelse return null), 0, 1);
    const alpha = if (n == 4) parseComponent(args[3], 1) orelse return null else 1;
    const q = if (l < 0.5) l * (1 + s) else l + s - l * s;
    const p = 2 * l - q;
    return .{
        .r = toByte(hueToChannel(p, q, h + 1.0 / 3.0) * 255),
        .g = toByte(hueToChannel(p, q, h) * 255),
        .b = toByte(hueToChannel(p, q, h - 1.0 / 3.0) * 255),
        .a = std.math.clamp(alpha, 0, 1),
    };
}

fn hueToChannel(p: f32, q: f32, t_raw: f32) f32 {
    const t = @mod(t_raw, 1.0);
    if (t < 1.0 / 6.0) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6;
    return p;
}

fn toByte(v: f32) u8 {
    return @intFromFloat(std.math.clamp(@round(v), 0, 255));
}

fn startsWithIgnoreCase(text: []const u8, prefix: []const u8) bool {
    return text.len >= prefix.len and std.ascii.eqlIgnoreCase(text[0..prefix.len], prefix);
}

const NamedColor = struct { name: []const u8, rgb: [3]u8 };

fn namedColor(value: []const u8) ?Color {
    var lower_buf: [32]u8 = undefined;
    if (value.len > lower_buf.len) return null;
    const lower = std.ascii.lowerString(&lower_buf, value);
    var low: usize = 0;
    var high: usize = named_colors.len;
    while (low < high) {
        const mid = low + (high - low) / 2;
        switch (std.mem.order(u8, lower, named_colors[mid].name)) {
            .lt => high = mid,
            .gt => low = mid + 1,
            .eq => {
                const rgb = named_colors[mid].rgb;
                return .{ .r = rgb[0], .g = rgb[1], .b = rgb[2] };
            },
        }
    }
    return null;
}

/// Parses a length into user units. Percentages resolve against
/// `percent_base`; font-relative units use `font_size`.
pub fn parseLength(raw: []const u8, percent_base: f64, font_size: f64) ?f64 {
    const value = std.mem.trim(u8, raw, " \t\r\n");
    if (value.len == 0) return null;
    var end: usize = 0;
    while (end < value.len and (std.ascii.isDigit(value[end]) or value[end] == '.' or value[end] == '-' or value[end] == '+' or
        ((value[end] == 'e' or value[end] == 'E') and end + 1 < value.len and (std.ascii.isDigit(value[end + 1]) or value[end + 1] == '-' or value[end + 1] == '+'))))
    {
        end += 1;
    }
    const number = std.fmt.parseFloat(f64, value[0..end]) catch return null;
    if (!std.math.isFinite(number)) return null;
    const unit = std.mem.trim(u8, value[end..], " ");
    const factor: f64 = if (unit.len == 0 or std.mem.eql(u8, unit, "px"))
        1
    else if (std.mem.eql(u8, unit, "%"))
        percent_base / 100
    else if (std.mem.eql(u8, unit, "pt"))
        4.0 / 3.0
    else if (std.mem.eql(u8, unit, "pc"))
        16
    else if (std.mem.eql(u8, unit, "in"))
        96
    else if (std.mem.eql(u8, unit, "cm"))
        96.0 / 2.54
    else if (std.mem.eql(u8, unit, "mm"))
        96.0 / 25.4
    else if (std.mem.eql(u8, unit, "em") or std.mem.eql(u8, unit, "rem"))
        font_size
    else if (std.mem.eql(u8, unit, "ex"))
        font_size / 2
    else
        return null;
    return number * factor;
}

pub const Declaration = struct {
    property: []const u8,
    value: []const u8,
};

/// Iterates `prop: value; ...` declarations (a `style` attribute or rule body).
pub const DeclarationIterator = struct {
    text: []const u8,
    pos: usize = 0,

    pub fn next(self: *DeclarationIterator) ?Declaration {
        while (self.pos < self.text.len) {
            const end = std.mem.indexOfScalarPos(u8, self.text, self.pos, ';') orelse self.text.len;
            const item = self.text[self.pos..end];
            self.pos = @min(self.text.len, end + 1);
            const colon = std.mem.indexOfScalar(u8, item, ':') orelse continue;
            const property = std.mem.trim(u8, item[0..colon], " \t\r\n");
            var value = std.mem.trim(u8, item[colon + 1 ..], " \t\r\n");
            if (std.mem.endsWith(u8, value, "!important")) value = std.mem.trim(u8, value[0 .. value.len - "!important".len], " ");
            if (property.len == 0) continue;
            return .{ .property = property, .value = value };
        }
        return null;
    }
};

pub const Selector = struct {
    tag: ?[]const u8 = null,
    id: ?[]const u8 = null,
    classes: [4][]const u8 = undefined,
    class_count: usize = 0,

    pub fn matches(self: Selector, tag: []const u8, id: ?[]const u8, class_attr: ?[]const u8) bool {
        if (self.tag) |t| if (!std.mem.eql(u8, t, tag)) return false;
        if (self.id) |want| {
            const have = id orelse return false;
            if (!std.mem.eql(u8, want, have)) return false;
        }
        for (self.classes[0..self.class_count]) |want| {
            const attr = class_attr orelse return false;
            var it = std.mem.tokenizeAny(u8, attr, " \t\r\n");
            const found = while (it.next()) |c| {
                if (std.mem.eql(u8, c, want)) break true;
            } else false;
            if (!found) return false;
        }
        return true;
    }
};

pub const Rule = struct {
    selector: Selector,
    declarations: []const u8,
};

/// Parses rules whose selectors this subset understands; others (for
/// example descendant combinators or pseudo-classes) are skipped.
pub fn parseStylesheet(alloc: Allocator, css: []const u8, rules: *std.ArrayList(Rule)) Allocator.Error!void {
    var pos: usize = 0;
    while (pos < css.len) {
        // Skip comments.
        if (std.mem.startsWith(u8, css[pos..], "/*")) {
            const end = std.mem.indexOfPos(u8, css, pos + 2, "*/") orelse return;
            pos = end + 2;
            continue;
        }
        const open = std.mem.indexOfScalarPos(u8, css, pos, '{') orelse return;
        const close = std.mem.indexOfScalarPos(u8, css, open, '}') orelse return;
        const selectors = std.mem.trim(u8, css[pos..open], " \t\r\n");
        const body = css[open + 1 .. close];
        pos = close + 1;
        if (selectors.len > 0 and selectors[0] == '@') continue;
        var it = std.mem.splitScalar(u8, selectors, ',');
        while (it.next()) |raw_selector| {
            const selector = parseSelector(std.mem.trim(u8, raw_selector, " \t\r\n")) orelse continue;
            try rules.append(alloc, .{ .selector = selector, .declarations = body });
        }
    }
}

fn parseSelector(text: []const u8) ?Selector {
    if (text.len == 0) return null;
    for (text) |c| if (std.ascii.isWhitespace(c) or c == '>' or c == ':' or c == '[' or c == '+' or c == '~') return null;
    var selector: Selector = .{};
    var i: usize = 0;
    if (text[0] == '*') {
        i = 1;
    } else if (text[0] != '.' and text[0] != '#') {
        while (i < text.len and text[i] != '.' and text[i] != '#') i += 1;
        selector.tag = text[0..i];
    }
    while (i < text.len) {
        const kind = text[i];
        var end = i + 1;
        while (end < text.len and text[end] != '.' and text[end] != '#') end += 1;
        const name = text[i + 1 .. end];
        if (name.len == 0) return null;
        if (kind == '#') {
            selector.id = name;
        } else if (kind == '.') {
            if (selector.class_count == selector.classes.len) return null;
            selector.classes[selector.class_count] = name;
            selector.class_count += 1;
        } else return null;
        i = end;
    }
    return selector;
}

/// CSS Color Module Level 4 named colors (sorted for binary search).
const named_colors = [_]NamedColor{
    .{ .name = "aliceblue", .rgb = .{ 240, 248, 255 } },
    .{ .name = "antiquewhite", .rgb = .{ 250, 235, 215 } },
    .{ .name = "aqua", .rgb = .{ 0, 255, 255 } },
    .{ .name = "aquamarine", .rgb = .{ 127, 255, 212 } },
    .{ .name = "azure", .rgb = .{ 240, 255, 255 } },
    .{ .name = "beige", .rgb = .{ 245, 245, 220 } },
    .{ .name = "bisque", .rgb = .{ 255, 228, 196 } },
    .{ .name = "black", .rgb = .{ 0, 0, 0 } },
    .{ .name = "blanchedalmond", .rgb = .{ 255, 235, 205 } },
    .{ .name = "blue", .rgb = .{ 0, 0, 255 } },
    .{ .name = "blueviolet", .rgb = .{ 138, 43, 226 } },
    .{ .name = "brown", .rgb = .{ 165, 42, 42 } },
    .{ .name = "burlywood", .rgb = .{ 222, 184, 135 } },
    .{ .name = "cadetblue", .rgb = .{ 95, 158, 160 } },
    .{ .name = "chartreuse", .rgb = .{ 127, 255, 0 } },
    .{ .name = "chocolate", .rgb = .{ 210, 105, 30 } },
    .{ .name = "coral", .rgb = .{ 255, 127, 80 } },
    .{ .name = "cornflowerblue", .rgb = .{ 100, 149, 237 } },
    .{ .name = "cornsilk", .rgb = .{ 255, 248, 220 } },
    .{ .name = "crimson", .rgb = .{ 220, 20, 60 } },
    .{ .name = "cyan", .rgb = .{ 0, 255, 255 } },
    .{ .name = "darkblue", .rgb = .{ 0, 0, 139 } },
    .{ .name = "darkcyan", .rgb = .{ 0, 139, 139 } },
    .{ .name = "darkgoldenrod", .rgb = .{ 184, 134, 11 } },
    .{ .name = "darkgray", .rgb = .{ 169, 169, 169 } },
    .{ .name = "darkgreen", .rgb = .{ 0, 100, 0 } },
    .{ .name = "darkgrey", .rgb = .{ 169, 169, 169 } },
    .{ .name = "darkkhaki", .rgb = .{ 189, 183, 107 } },
    .{ .name = "darkmagenta", .rgb = .{ 139, 0, 139 } },
    .{ .name = "darkolivegreen", .rgb = .{ 85, 107, 47 } },
    .{ .name = "darkorange", .rgb = .{ 255, 140, 0 } },
    .{ .name = "darkorchid", .rgb = .{ 153, 50, 204 } },
    .{ .name = "darkred", .rgb = .{ 139, 0, 0 } },
    .{ .name = "darksalmon", .rgb = .{ 233, 150, 122 } },
    .{ .name = "darkseagreen", .rgb = .{ 143, 188, 143 } },
    .{ .name = "darkslateblue", .rgb = .{ 72, 61, 139 } },
    .{ .name = "darkslategray", .rgb = .{ 47, 79, 79 } },
    .{ .name = "darkslategrey", .rgb = .{ 47, 79, 79 } },
    .{ .name = "darkturquoise", .rgb = .{ 0, 206, 209 } },
    .{ .name = "darkviolet", .rgb = .{ 148, 0, 211 } },
    .{ .name = "deeppink", .rgb = .{ 255, 20, 147 } },
    .{ .name = "deepskyblue", .rgb = .{ 0, 191, 255 } },
    .{ .name = "dimgray", .rgb = .{ 105, 105, 105 } },
    .{ .name = "dimgrey", .rgb = .{ 105, 105, 105 } },
    .{ .name = "dodgerblue", .rgb = .{ 30, 144, 255 } },
    .{ .name = "firebrick", .rgb = .{ 178, 34, 34 } },
    .{ .name = "floralwhite", .rgb = .{ 255, 250, 240 } },
    .{ .name = "forestgreen", .rgb = .{ 34, 139, 34 } },
    .{ .name = "fuchsia", .rgb = .{ 255, 0, 255 } },
    .{ .name = "gainsboro", .rgb = .{ 220, 220, 220 } },
    .{ .name = "ghostwhite", .rgb = .{ 248, 248, 255 } },
    .{ .name = "gold", .rgb = .{ 255, 215, 0 } },
    .{ .name = "goldenrod", .rgb = .{ 218, 165, 32 } },
    .{ .name = "gray", .rgb = .{ 128, 128, 128 } },
    .{ .name = "green", .rgb = .{ 0, 128, 0 } },
    .{ .name = "greenyellow", .rgb = .{ 173, 255, 47 } },
    .{ .name = "grey", .rgb = .{ 128, 128, 128 } },
    .{ .name = "honeydew", .rgb = .{ 240, 255, 240 } },
    .{ .name = "hotpink", .rgb = .{ 255, 105, 180 } },
    .{ .name = "indianred", .rgb = .{ 205, 92, 92 } },
    .{ .name = "indigo", .rgb = .{ 75, 0, 130 } },
    .{ .name = "ivory", .rgb = .{ 255, 255, 240 } },
    .{ .name = "khaki", .rgb = .{ 240, 230, 140 } },
    .{ .name = "lavender", .rgb = .{ 230, 230, 250 } },
    .{ .name = "lavenderblush", .rgb = .{ 255, 240, 245 } },
    .{ .name = "lawngreen", .rgb = .{ 124, 252, 0 } },
    .{ .name = "lemonchiffon", .rgb = .{ 255, 250, 205 } },
    .{ .name = "lightblue", .rgb = .{ 173, 216, 230 } },
    .{ .name = "lightcoral", .rgb = .{ 240, 128, 128 } },
    .{ .name = "lightcyan", .rgb = .{ 224, 255, 255 } },
    .{ .name = "lightgoldenrodyellow", .rgb = .{ 250, 250, 210 } },
    .{ .name = "lightgray", .rgb = .{ 211, 211, 211 } },
    .{ .name = "lightgreen", .rgb = .{ 144, 238, 144 } },
    .{ .name = "lightgrey", .rgb = .{ 211, 211, 211 } },
    .{ .name = "lightpink", .rgb = .{ 255, 182, 193 } },
    .{ .name = "lightsalmon", .rgb = .{ 255, 160, 122 } },
    .{ .name = "lightseagreen", .rgb = .{ 32, 178, 170 } },
    .{ .name = "lightskyblue", .rgb = .{ 135, 206, 250 } },
    .{ .name = "lightslategray", .rgb = .{ 119, 136, 153 } },
    .{ .name = "lightslategrey", .rgb = .{ 119, 136, 153 } },
    .{ .name = "lightsteelblue", .rgb = .{ 176, 196, 222 } },
    .{ .name = "lightyellow", .rgb = .{ 255, 255, 224 } },
    .{ .name = "lime", .rgb = .{ 0, 255, 0 } },
    .{ .name = "limegreen", .rgb = .{ 50, 205, 50 } },
    .{ .name = "linen", .rgb = .{ 250, 240, 230 } },
    .{ .name = "magenta", .rgb = .{ 255, 0, 255 } },
    .{ .name = "maroon", .rgb = .{ 128, 0, 0 } },
    .{ .name = "mediumaquamarine", .rgb = .{ 102, 205, 170 } },
    .{ .name = "mediumblue", .rgb = .{ 0, 0, 205 } },
    .{ .name = "mediumorchid", .rgb = .{ 186, 85, 211 } },
    .{ .name = "mediumpurple", .rgb = .{ 147, 112, 219 } },
    .{ .name = "mediumseagreen", .rgb = .{ 60, 179, 113 } },
    .{ .name = "mediumslateblue", .rgb = .{ 123, 104, 238 } },
    .{ .name = "mediumspringgreen", .rgb = .{ 0, 250, 154 } },
    .{ .name = "mediumturquoise", .rgb = .{ 72, 209, 204 } },
    .{ .name = "mediumvioletred", .rgb = .{ 199, 21, 133 } },
    .{ .name = "midnightblue", .rgb = .{ 25, 25, 112 } },
    .{ .name = "mintcream", .rgb = .{ 245, 255, 250 } },
    .{ .name = "mistyrose", .rgb = .{ 255, 228, 225 } },
    .{ .name = "moccasin", .rgb = .{ 255, 228, 181 } },
    .{ .name = "navajowhite", .rgb = .{ 255, 222, 173 } },
    .{ .name = "navy", .rgb = .{ 0, 0, 128 } },
    .{ .name = "oldlace", .rgb = .{ 253, 245, 230 } },
    .{ .name = "olive", .rgb = .{ 128, 128, 0 } },
    .{ .name = "olivedrab", .rgb = .{ 107, 142, 35 } },
    .{ .name = "orange", .rgb = .{ 255, 165, 0 } },
    .{ .name = "orangered", .rgb = .{ 255, 69, 0 } },
    .{ .name = "orchid", .rgb = .{ 218, 112, 214 } },
    .{ .name = "palegoldenrod", .rgb = .{ 238, 232, 170 } },
    .{ .name = "palegreen", .rgb = .{ 152, 251, 152 } },
    .{ .name = "paleturquoise", .rgb = .{ 175, 238, 238 } },
    .{ .name = "palevioletred", .rgb = .{ 219, 112, 147 } },
    .{ .name = "papayawhip", .rgb = .{ 255, 239, 213 } },
    .{ .name = "peachpuff", .rgb = .{ 255, 218, 185 } },
    .{ .name = "peru", .rgb = .{ 205, 133, 63 } },
    .{ .name = "pink", .rgb = .{ 255, 192, 203 } },
    .{ .name = "plum", .rgb = .{ 221, 160, 221 } },
    .{ .name = "powderblue", .rgb = .{ 176, 224, 230 } },
    .{ .name = "purple", .rgb = .{ 128, 0, 128 } },
    .{ .name = "rebeccapurple", .rgb = .{ 102, 51, 153 } },
    .{ .name = "red", .rgb = .{ 255, 0, 0 } },
    .{ .name = "rosybrown", .rgb = .{ 188, 143, 143 } },
    .{ .name = "royalblue", .rgb = .{ 65, 105, 225 } },
    .{ .name = "saddlebrown", .rgb = .{ 139, 69, 19 } },
    .{ .name = "salmon", .rgb = .{ 250, 128, 114 } },
    .{ .name = "sandybrown", .rgb = .{ 244, 164, 96 } },
    .{ .name = "seagreen", .rgb = .{ 46, 139, 87 } },
    .{ .name = "seashell", .rgb = .{ 255, 245, 238 } },
    .{ .name = "sienna", .rgb = .{ 160, 82, 45 } },
    .{ .name = "silver", .rgb = .{ 192, 192, 192 } },
    .{ .name = "skyblue", .rgb = .{ 135, 206, 235 } },
    .{ .name = "slateblue", .rgb = .{ 106, 90, 205 } },
    .{ .name = "slategray", .rgb = .{ 112, 128, 144 } },
    .{ .name = "slategrey", .rgb = .{ 112, 128, 144 } },
    .{ .name = "snow", .rgb = .{ 255, 250, 250 } },
    .{ .name = "springgreen", .rgb = .{ 0, 255, 127 } },
    .{ .name = "steelblue", .rgb = .{ 70, 130, 180 } },
    .{ .name = "tan", .rgb = .{ 210, 180, 140 } },
    .{ .name = "teal", .rgb = .{ 0, 128, 128 } },
    .{ .name = "thistle", .rgb = .{ 216, 191, 216 } },
    .{ .name = "tomato", .rgb = .{ 255, 99, 71 } },
    .{ .name = "turquoise", .rgb = .{ 64, 224, 208 } },
    .{ .name = "violet", .rgb = .{ 238, 130, 238 } },
    .{ .name = "wheat", .rgb = .{ 245, 222, 179 } },
    .{ .name = "white", .rgb = .{ 255, 255, 255 } },
    .{ .name = "whitesmoke", .rgb = .{ 245, 245, 245 } },
    .{ .name = "yellow", .rgb = .{ 255, 255, 0 } },
    .{ .name = "yellowgreen", .rgb = .{ 154, 205, 50 } },
};
test "parses colors in every supported form" {
    try std.testing.expectEqual(Color{ .r = 255, .g = 0, .b = 0 }, parseColor("#f00").?);
    try std.testing.expectEqual(Color{ .r = 0x12, .g = 0x34, .b = 0x56 }, parseColor("#123456").?);
    try std.testing.expectEqual(@as(f32, 0.5), parseColor("rgba(10, 20, 30, 0.5)").?.a);
    try std.testing.expectEqual(Color{ .r = 255, .g = 128, .b = 0 }, parseColor("rgb(100% 50% 0%)").?);
    try std.testing.expectEqual(Color{ .r = 0, .g = 255, .b = 0 }, parseColor("hsl(120, 100%, 50%)").?);
    try std.testing.expectEqual(Color{ .r = 102, .g = 51, .b = 153 }, parseColor("RebeccaPurple").?);
    try std.testing.expectEqual(@as(?Color, null), parseColor("notacolor"));
    try std.testing.expect(parsePaint("none").? == .none);
    try std.testing.expectEqualStrings("grad", parsePaint("url(#grad) red").?.reference.id);
}

test "parses lengths and declarations" {
    try std.testing.expectEqual(@as(?f64, 12), parseLength("12px", 0, 16));
    try std.testing.expectEqual(@as(?f64, 50), parseLength("25%", 200, 16));
    try std.testing.expectEqual(@as(?f64, 32), parseLength("2em", 0, 16));
    try std.testing.expectEqual(@as(?f64, 1e3), parseLength("1e3", 0, 16));
    var it = DeclarationIterator{ .text = "fill: red; stroke:#000 !important;; bad" };
    try std.testing.expectEqualStrings("fill", it.next().?.property);
    try std.testing.expectEqualStrings("#000", it.next().?.value);
    try std.testing.expectEqual(@as(?Declaration, null), it.next());
}

test "stylesheet selectors match tags, classes, and ids" {
    const alloc = std.testing.allocator;
    var rules: std.ArrayList(Rule) = .empty;
    defer rules.deinit(alloc);
    try parseStylesheet(alloc, "/* c */ rect.box, #hero { fill: red } g text { fill: blue } @media x { }", &rules);
    try std.testing.expectEqual(@as(usize, 2), rules.items.len);
    try std.testing.expect(rules.items[0].selector.matches("rect", null, "box other"));
    try std.testing.expect(!rules.items[0].selector.matches("circle", null, "box"));
    try std.testing.expect(rules.items[1].selector.matches("circle", "hero", null));
}
