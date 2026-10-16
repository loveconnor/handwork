//! SVG path data (`d` attribute) parsing into a flattened `canvas.Path`.
//! Errors stop parsing and keep what was built so far, as browsers do.

const std = @import("std");
const canvas = @import("canvas.zig");

const Point = canvas.Point;

const Scanner = struct {
    text: []const u8,
    pos: usize = 0,

    fn skipSeparators(self: *Scanner) void {
        while (self.pos < self.text.len and (std.ascii.isWhitespace(self.text[self.pos]) or self.text[self.pos] == ',')) self.pos += 1;
    }

    fn peekCommand(self: *Scanner) ?u8 {
        self.skipSeparators();
        if (self.pos >= self.text.len) return null;
        const c = self.text[self.pos];
        return if (std.ascii.isAlphabetic(c) and c != 'e' and c != 'E') c else null;
    }

    fn atNumber(self: *Scanner) bool {
        self.skipSeparators();
        if (self.pos >= self.text.len) return false;
        const c = self.text[self.pos];
        return std.ascii.isDigit(c) or c == '-' or c == '+' or c == '.';
    }

    fn number(self: *Scanner) ?f64 {
        self.skipSeparators();
        const start = self.pos;
        if (self.pos < self.text.len and (self.text[self.pos] == '-' or self.text[self.pos] == '+')) self.pos += 1;
        var saw_dot = false;
        var saw_digit = false;
        while (self.pos < self.text.len) : (self.pos += 1) {
            const c = self.text[self.pos];
            if (std.ascii.isDigit(c)) {
                saw_digit = true;
            } else if (c == '.' and !saw_dot) {
                saw_dot = true;
            } else break;
        }
        if (!saw_digit) {
            self.pos = start;
            return null;
        }
        if (self.pos < self.text.len and (self.text[self.pos] == 'e' or self.text[self.pos] == 'E')) {
            var p = self.pos + 1;
            if (p < self.text.len and (self.text[p] == '-' or self.text[p] == '+')) p += 1;
            if (p < self.text.len and std.ascii.isDigit(self.text[p])) {
                while (p < self.text.len and std.ascii.isDigit(self.text[p])) p += 1;
                self.pos = p;
            }
        }
        const value = std.fmt.parseFloat(f64, self.text[start..self.pos]) catch return null;
        return if (std.math.isFinite(value)) value else null;
    }

    /// Arc flags may be written without separators ("a1 1 0 01 5 5").
    fn flag(self: *Scanner) ?bool {
        self.skipSeparators();
        if (self.pos >= self.text.len) return null;
        const c = self.text[self.pos];
        if (c != '0' and c != '1') return null;
        self.pos += 1;
        return c == '1';
    }
};

pub fn build(path: *canvas.Path, data: []const u8) !void {
    var s = Scanner{ .text = data };
    var current = Point{ .x = 0, .y = 0 };
    var start = current;
    var last_control: ?Point = null;
    var previous: u8 = 0;
    var command: u8 = 0;
    while (true) {
        if (s.peekCommand()) |c| {
            command = c;
            s.pos += 1;
        } else if (command == 0 or !s.atNumber()) {
            return;
        } else if (command == 'M') {
            command = 'L';
        } else if (command == 'm') {
            command = 'l';
        }
        const relative = std.ascii.isLower(command);
        const base = if (relative) current else Point{ .x = 0, .y = 0 };
        switch (std.ascii.toUpper(command)) {
            'M' => {
                const p = readPoint(&s, base) orelse return;
                try path.moveTo(p);
                current = p;
                start = p;
                last_control = null;
            },
            'L' => {
                const p = readPoint(&s, base) orelse return;
                try path.lineTo(p);
                current = p;
                last_control = null;
            },
            'H' => {
                const x = s.number() orelse return;
                current = .{ .x = if (relative) current.x + x else x, .y = current.y };
                try path.lineTo(current);
                last_control = null;
            },
            'V' => {
                const y = s.number() orelse return;
                current = .{ .x = current.x, .y = if (relative) current.y + y else y };
                try path.lineTo(current);
                last_control = null;
            },
            'C' => {
                const c1 = readPoint(&s, base) orelse return;
                const c2 = readPoint(&s, base) orelse return;
                const p = readPoint(&s, base) orelse return;
                try ensureStarted(path, current);
                try path.cubicTo(c1, c2, p);
                current = p;
                last_control = c2;
            },
            'S' => {
                const c2 = readPoint(&s, base) orelse return;
                const p = readPoint(&s, base) orelse return;
                const reflect = std.ascii.toUpper(previous) == 'C' or std.ascii.toUpper(previous) == 'S';
                const c1 = if (reflect and last_control != null) reflection(current, last_control.?) else current;
                try ensureStarted(path, current);
                try path.cubicTo(c1, c2, p);
                current = p;
                last_control = c2;
            },
            'Q' => {
                const c = readPoint(&s, base) orelse return;
                const p = readPoint(&s, base) orelse return;
                try ensureStarted(path, current);
                try path.quadTo(c, p);
                current = p;
                last_control = c;
            },
            'T' => {
                const p = readPoint(&s, base) orelse return;
                const reflect = std.ascii.toUpper(previous) == 'Q' or std.ascii.toUpper(previous) == 'T';
                const c = if (reflect and last_control != null) reflection(current, last_control.?) else current;
                try ensureStarted(path, current);
                try path.quadTo(c, p);
                current = p;
                last_control = c;
            },
            'A' => {
                const rx = s.number() orelse return;
                const ry = s.number() orelse return;
                const rotation = s.number() orelse return;
                const large = s.flag() orelse return;
                const sweep = s.flag() orelse return;
                const p = readPoint(&s, base) orelse return;
                try ensureStarted(path, current);
                try path.arcTo(rx, ry, rotation, large, sweep, p);
                current = p;
                last_control = null;
            },
            'Z' => {
                path.close();
                current = start;
                last_control = null;
                // A drawing command after Z starts a new subpath at the start point.
                if (s.peekCommand()) |next| {
                    if (std.ascii.toUpper(next) != 'M') try path.moveTo(start);
                }
            },
            else => return,
        }
        previous = command;
    }
}

fn ensureStarted(path: *canvas.Path, current: Point) !void {
    if (path.lastPoint() == null) try path.moveTo(current);
}

fn readPoint(s: *Scanner, base: Point) ?Point {
    const x = s.number() orelse return null;
    const y = s.number() orelse return null;
    return .{ .x = base.x + x, .y = base.y + y };
}

fn reflection(current: Point, control: Point) Point {
    return .{ .x = 2 * current.x - control.x, .y = 2 * current.y - control.y };
}

test "parses absolute, relative, implicit, and compact commands" {
    const alloc = std.testing.allocator;
    var path = canvas.Path.init(alloc, 0.1);
    defer path.deinit();
    try build(&path, "M10,10 l5-5 5 5H30v10h-5zm1,1 L2.5.5");
    try std.testing.expectEqual(@as(usize, 2), path.contours.items.len);
    const first = path.contours.items[0];
    try std.testing.expect(first.closed);
    try std.testing.expectEqual(Point{ .x = 15, .y = 5 }, first.points.items[1]);
    try std.testing.expectEqual(Point{ .x = 20, .y = 10 }, first.points.items[2]);
    try std.testing.expectEqual(Point{ .x = 25, .y = 20 }, first.points.items[5]);
    const second = path.contours.items[1];
    try std.testing.expectEqual(Point{ .x = 11, .y = 11 }, second.points.items[0]);
    try std.testing.expectEqual(Point{ .x = 2.5, .y = 0.5 }, second.points.items[1]);
}

test "curves and compact arc flags end at their targets" {
    const alloc = std.testing.allocator;
    var path = canvas.Path.init(alloc, 0.1);
    defer path.deinit();
    try build(&path, "M0 0C0 10 10 10 10 0S20 -10 20 0Q25 5 30 0T40 0a5 5 0 0110 0");
    try std.testing.expectEqual(Point{ .x = 50, .y = 0 }, path.lastPoint().?);
}

test "malformed data keeps the valid prefix" {
    const alloc = std.testing.allocator;
    var path = canvas.Path.init(alloc, 0.1);
    defer path.deinit();
    try build(&path, "M0 0 L10 10 L oops 20 20");
    try std.testing.expectEqual(Point{ .x = 10, .y = 10 }, path.lastPoint().?);
}
