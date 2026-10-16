//! Text layout with the Hershey Simplex stroke font. Glyphs become open
//! polylines that callers stroke, so text stays sharp at any scale.
//! Characters outside printable ASCII map to close equivalents or `?`.

const std = @import("std");
const canvas = @import("canvas.zig");
const font = @import("hershey_simplex.zig");

/// Font units per em: capitals (21 units tall) come out at ~0.7 em.
const units_per_em = 30.0;
const baseline_unit = 9.0;
const cap_height_units = 21.0;

pub fn capHeight(font_size: f64) f64 {
    return font_size * cap_height_units / units_per_em;
}

pub fn strokeWidth(font_size: f64, bold: bool) f64 {
    return font_size * @as(f64, if (bold) 0.13 else 0.085);
}

/// Iterates the glyph characters a string renders as.
const GlyphIterator = struct {
    text: []const u8,
    pos: usize = 0,
    pending: []const u8 = "",

    fn next(self: *GlyphIterator) ?u8 {
        if (self.pending.len > 0) {
            defer self.pending = self.pending[1..];
            return self.pending[0];
        }
        if (self.pos >= self.text.len) return null;
        const len = std.unicode.utf8ByteSequenceLength(self.text[self.pos]) catch {
            self.pos += 1;
            return '?';
        };
        if (self.pos + len > self.text.len) {
            self.pos = self.text.len;
            return '?';
        }
        const cp = std.unicode.utf8Decode(self.text[self.pos .. self.pos + len]) catch {
            self.pos += len;
            return '?';
        };
        self.pos += len;
        if (cp >= 0x20 and cp < 0x7f) return @intCast(cp);
        const replacement: []const u8 = switch (cp) {
            '\t', '\n', '\r', 0xa0, 0x2002...0x200a, 0x202f => " ",
            0x2018, 0x2019, 0x201a, 0x2032 => "'",
            0x201c, 0x201d, 0x201e, 0x2033 => "\"",
            0x2010...0x2015, 0x2212 => "-",
            0x2026 => "...",
            0x2022, 0x00b7, 0x2219 => "*",
            0x2192, 0x27f6 => "->",
            0x2190, 0x27f5 => "<-",
            0x2194 => "<->",
            0x00d7 => "x",
            0x2264 => "<=",
            0x2265 => ">=",
            0x2260 => "!=",
            0x00a9 => "(c)",
            0x00ae => "(R)",
            0x2122 => "TM",
            else => if (asciiFold(cp)) |c| return c else "?",
        };
        if (replacement.len == 0) return self.next();
        self.pending = replacement[1..];
        return replacement[0];
    }
};

/// Strips accents from common Latin-1 letters.
fn asciiFold(cp: u21) ?u8 {
    return switch (cp) {
        0xc0...0xc5 => 'A',
        0xc7 => 'C',
        0xc8...0xcb => 'E',
        0xcc...0xcf => 'I',
        0xd1 => 'N',
        0xd2...0xd6, 0xd8 => 'O',
        0xd9...0xdc => 'U',
        0xdd => 'Y',
        0xe0...0xe5 => 'a',
        0xe7 => 'c',
        0xe8...0xeb => 'e',
        0xec...0xef => 'i',
        0xf1 => 'n',
        0xf2...0xf6, 0xf8 => 'o',
        0xf9...0xfc => 'u',
        0xfd, 0xff => 'y',
        0xdf => 's',
        else => null,
    };
}

fn glyphFor(c: u8) font.Glyph {
    const index: usize = if (c >= 0x20 and c < 0x7f) c - 0x20 else '?' - 0x20;
    return font.glyphs[index];
}

/// Advance width of `text` in user units.
pub fn measure(text: []const u8, font_size: f64) f64 {
    const unit = font_size / units_per_em;
    var it = GlyphIterator{ .text = text };
    var width: f64 = 0;
    while (it.next()) |c| {
        const g = glyphFor(c);
        width += @as(f64, @floatFromInt(@as(i32, g.right) - g.left)) * unit;
    }
    return width;
}

/// Appends the glyph strokes of `text` with its baseline starting at
/// (`x`, `y`). Returns the advance width.
pub fn appendStrokes(path: *canvas.Path, text: []const u8, x: f64, y: f64, font_size: f64) !f64 {
    const unit = font_size / units_per_em;
    var it = GlyphIterator{ .text = text };
    var pen_x = x;
    while (it.next()) |c| {
        const g = glyphFor(c);
        const origin_x = pen_x - @as(f64, @floatFromInt(g.left)) * unit;
        var i: usize = g.start;
        var starting = true;
        while (i < g.end) {
            if (font.points[i] == font.pen_up) {
                starting = true;
                i += 1;
                continue;
            }
            const point = canvas.Point{
                .x = origin_x + @as(f64, @floatFromInt(font.points[i])) * unit,
                .y = y + (@as(f64, @floatFromInt(font.points[i + 1])) - baseline_unit) * unit,
            };
            if (starting) {
                try path.moveTo(point);
                starting = false;
            } else {
                try path.lineTo(point);
            }
            i += 2;
        }
        pen_x += @as(f64, @floatFromInt(@as(i32, g.right) - g.left)) * unit;
    }
    return pen_x - x;
}

test "measures and lays out ASCII with typographic fallbacks" {
    const alloc = std.testing.allocator;
    try std.testing.expect(measure("Hello", 30) > measure("Hi", 30));
    try std.testing.expectEqual(measure("...", 30), measure("\u{2026}", 30));
    var path = canvas.Path.init(alloc, 0.1);
    defer path.deinit();
    const advance = try appendStrokes(&path, "H", 0, 100, 30);
    try std.testing.expectEqual(measure("H", 30), advance);
    // H is three strokes: two stems and a bar, all between cap top and baseline.
    try std.testing.expectEqual(@as(usize, 3), path.contours.items.len);
    const b = path.bounds().?;
    try std.testing.expectApproxEqAbs(@as(f64, 100 - 21), b.min.y, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100), b.max.y, 1e-9);
}
