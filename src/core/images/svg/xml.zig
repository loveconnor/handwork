//! Minimal XML parser for SVG documents: elements, attributes, text, and
//! CDATA. Comments, processing instructions, and DOCTYPE are skipped;
//! external entities are never resolved. Depth and node counts are
//! bounded so hostile markup cannot exhaust the stack or memory.

const std = @import("std");

const Allocator = std.mem.Allocator;

pub const Error = Allocator.Error || error{InvalidSvg};

const max_depth = 256;
const max_nodes = 200_000;

pub const Attribute = struct {
    /// Local name; namespace prefixes other than `xlink:` are dropped.
    name: []const u8,
    value: []const u8,
};

pub const text_node_name = "#text";

pub const Node = struct {
    /// Element name, or `text_node_name` for character data, which keeps
    /// mixed content (text interleaved with elements) in document order.
    name: []const u8,
    attributes: []Attribute,
    children: []*Node,
    /// For text nodes, their characters; for elements, all character data
    /// directly inside them, concatenated (used by `<style>`).
    text: []const u8,
    parent: ?*Node = null,

    pub fn attribute(self: *const Node, name: []const u8) ?[]const u8 {
        for (self.attributes) |a| {
            if (std.mem.eql(u8, a.name, name)) return a.value;
        }
        return null;
    }
};

/// Parsed document; everything lives in the arena.
pub const Document = struct {
    arena: std.heap.ArenaAllocator,
    root: *Node,

    pub fn deinit(self: *Document) void {
        self.arena.deinit();
    }

    pub fn findById(self: *const Document, id: []const u8) ?*Node {
        return findIn(self.root, id);
    }

    fn findIn(node: *Node, id: []const u8) ?*Node {
        if (node.attribute("id")) |value| {
            if (std.mem.eql(u8, value, id)) return node;
        }
        for (node.children) |child| {
            if (findIn(child, id)) |found| return found;
        }
        return null;
    }
};

pub fn parse(gpa: Allocator, source: []const u8) Error!Document {
    var doc = Document{ .arena = .init(gpa), .root = undefined };
    errdefer doc.arena.deinit();
    var parser = Parser{ .alloc = doc.arena.allocator(), .src = source };
    doc.root = try parser.parseDocument();
    return doc;
}

const Parser = struct {
    alloc: Allocator,
    src: []const u8,
    pos: usize = 0,
    nodes: usize = 0,

    fn parseDocument(self: *Parser) Error!*Node {
        while (true) {
            self.skipWhitespace();
            if (self.pos >= self.src.len) return error.InvalidSvg;
            if (self.startsWith("<?")) {
                try self.skipPast("?>");
            } else if (self.startsWith("<!--")) {
                try self.skipPast("-->");
            } else if (self.startsWith("<!")) {
                try self.skipDoctype();
            } else if (self.src[self.pos] == '<') {
                return self.parseElement(null, 0);
            } else {
                // Stray text before the root (for example a BOM) is ignored.
                self.pos += 1;
            }
        }
    }

    fn parseElement(self: *Parser, parent: ?*Node, depth: usize) Error!*Node {
        if (depth > max_depth) return error.InvalidSvg;
        self.nodes += 1;
        if (self.nodes > max_nodes) return error.InvalidSvg;
        std.debug.assert(self.src[self.pos] == '<');
        self.pos += 1;
        const name = stripNamespace(self.readName());
        if (name.len == 0) return error.InvalidSvg;

        var attributes: std.ArrayList(Attribute) = .empty;
        while (true) {
            self.skipWhitespace();
            if (self.pos >= self.src.len) return error.InvalidSvg;
            const c = self.src[self.pos];
            if (c == '/' or c == '>') break;
            const raw_name = self.readName();
            if (raw_name.len == 0) return error.InvalidSvg;
            self.skipWhitespace();
            if (self.pos >= self.src.len or self.src[self.pos] != '=') return error.InvalidSvg;
            self.pos += 1;
            self.skipWhitespace();
            if (self.pos >= self.src.len) return error.InvalidSvg;
            const quote = self.src[self.pos];
            if (quote != '"' and quote != '\'') return error.InvalidSvg;
            self.pos += 1;
            const start = self.pos;
            while (self.pos < self.src.len and self.src[self.pos] != quote) self.pos += 1;
            if (self.pos >= self.src.len) return error.InvalidSvg;
            const value = try self.decodeEntities(self.src[start..self.pos]);
            self.pos += 1;
            try attributes.append(self.alloc, .{ .name = attributeName(raw_name), .value = value });
        }

        const node = try self.alloc.create(Node);
        node.* = .{ .name = name, .attributes = try attributes.toOwnedSlice(self.alloc), .children = &.{}, .text = "", .parent = parent };
        if (self.src[self.pos] == '/') {
            if (self.pos + 1 >= self.src.len or self.src[self.pos + 1] != '>') return error.InvalidSvg;
            self.pos += 2;
            return node;
        }
        self.pos += 1;

        var children: std.ArrayList(*Node) = .empty;
        var text: std.ArrayList(u8) = .empty;
        while (true) {
            if (self.pos >= self.src.len) return error.InvalidSvg;
            if (self.startsWith("</")) {
                self.pos += 2;
                _ = self.readName();
                self.skipWhitespace();
                if (self.pos >= self.src.len or self.src[self.pos] != '>') return error.InvalidSvg;
                self.pos += 1;
                break;
            } else if (self.startsWith("<!--")) {
                try self.skipPast("-->");
            } else if (self.startsWith("<![CDATA[")) {
                self.pos += "<![CDATA[".len;
                const end = std.mem.indexOfPos(u8, self.src, self.pos, "]]>") orelse return error.InvalidSvg;
                const data = self.src[self.pos..end];
                try text.appendSlice(self.alloc, data);
                try children.append(self.alloc, try self.textNode(node, data));
                self.pos = end + 3;
            } else if (self.startsWith("<?")) {
                try self.skipPast("?>");
            } else if (self.src[self.pos] == '<') {
                try children.append(self.alloc, try self.parseElement(node, depth + 1));
            } else {
                const start = self.pos;
                while (self.pos < self.src.len and self.src[self.pos] != '<') self.pos += 1;
                const data = try self.decodeEntities(self.src[start..self.pos]);
                try text.appendSlice(self.alloc, data);
                try children.append(self.alloc, try self.textNode(node, data));
            }
        }
        node.children = try children.toOwnedSlice(self.alloc);
        node.text = try text.toOwnedSlice(self.alloc);
        return node;
    }

    fn textNode(self: *Parser, parent: *Node, data: []const u8) Error!*Node {
        self.nodes += 1;
        if (self.nodes > max_nodes) return error.InvalidSvg;
        const node = try self.alloc.create(Node);
        node.* = .{ .name = text_node_name, .attributes = &.{}, .children = &.{}, .text = data, .parent = parent };
        return node;
    }

    fn readName(self: *Parser) []const u8 {
        const start = self.pos;
        while (self.pos < self.src.len) : (self.pos += 1) {
            const c = self.src[self.pos];
            if (std.ascii.isWhitespace(c) or c == '=' or c == '>' or c == '/' or c == '<') break;
        }
        return self.src[start..self.pos];
    }

    fn skipWhitespace(self: *Parser) void {
        while (self.pos < self.src.len and std.ascii.isWhitespace(self.src[self.pos])) self.pos += 1;
    }

    fn startsWith(self: *const Parser, prefix: []const u8) bool {
        return std.mem.startsWith(u8, self.src[self.pos..], prefix);
    }

    fn skipPast(self: *Parser, terminator: []const u8) Error!void {
        const end = std.mem.indexOfPos(u8, self.src, self.pos, terminator) orelse return error.InvalidSvg;
        self.pos = end + terminator.len;
    }

    /// DOCTYPE may hold an internal subset in brackets; entities declared
    /// there are deliberately ignored.
    fn skipDoctype(self: *Parser) Error!void {
        var depth: usize = 0;
        while (self.pos < self.src.len) : (self.pos += 1) {
            switch (self.src[self.pos]) {
                '[' => depth += 1,
                ']' => depth -|= 1,
                '>' => if (depth == 0) {
                    self.pos += 1;
                    return;
                },
                else => {},
            }
        }
        return error.InvalidSvg;
    }

    fn decodeEntities(self: *Parser, raw: []const u8) Error![]const u8 {
        if (std.mem.indexOfScalar(u8, raw, '&') == null) return raw;
        var out: std.ArrayList(u8) = .empty;
        var i: usize = 0;
        while (i < raw.len) {
            if (raw[i] != '&') {
                try out.append(self.alloc, raw[i]);
                i += 1;
                continue;
            }
            const end = std.mem.indexOfScalarPos(u8, raw, i, ';') orelse {
                try out.append(self.alloc, '&');
                i += 1;
                continue;
            };
            const entity = raw[i + 1 .. end];
            const named = [_]struct { []const u8, []const u8 }{
                .{ "amp", "&" }, .{ "lt", "<" }, .{ "gt", ">" }, .{ "quot", "\"" }, .{ "apos", "'" }, .{ "nbsp", "\u{a0}" },
            };
            var replaced = false;
            for (named) |pair| {
                if (std.mem.eql(u8, entity, pair[0])) {
                    try out.appendSlice(self.alloc, pair[1]);
                    replaced = true;
                }
            }
            if (!replaced and entity.len > 1 and entity[0] == '#') {
                const cp = if (entity[1] == 'x' or entity[1] == 'X')
                    std.fmt.parseInt(u21, entity[2..], 16) catch null
                else
                    std.fmt.parseInt(u21, entity[1..], 10) catch null;
                if (cp) |codepoint| {
                    var buf: [4]u8 = undefined;
                    const n = std.unicode.utf8Encode(codepoint, &buf) catch 0;
                    try out.appendSlice(self.alloc, buf[0..n]);
                    replaced = true;
                }
            }
            if (!replaced) try out.appendSlice(self.alloc, raw[i .. end + 1]);
            i = end + 1;
        }
        return out.toOwnedSlice(self.alloc);
    }
};

fn stripNamespace(name: []const u8) []const u8 {
    const colon = std.mem.indexOfScalar(u8, name, ':') orelse return name;
    return name[colon + 1 ..];
}

/// `xlink:href` keeps its prefix-free spelling `href`; other prefixed
/// attributes (for example `xml:space`) keep their local names.
fn attributeName(raw: []const u8) []const u8 {
    return stripNamespace(raw);
}

test "parses elements, attributes, entities, and nested text" {
    const alloc = std.testing.allocator;
    var doc = try parse(alloc,
        \\<?xml version="1.0"?>
        \\<!DOCTYPE svg [ <!ENTITY x "boom"> ]>
        \\<svg xmlns="http://www.w3.org/2000/svg" width='10'>
        \\  <!-- comment -->
        \\  <g id="a"><rect x="1" fill="#f00"/><text>A &amp; B &#65;<![CDATA[<raw>]]></text></g>
        \\  <use xlink:href="#a"/>
        \\</svg>
    );
    defer doc.deinit();
    try std.testing.expectEqualStrings("svg", doc.root.name);
    try std.testing.expectEqualStrings("10", doc.root.attribute("width").?);
    const g = doc.findById("a").?;
    try std.testing.expectEqualStrings("rect", g.children[0].name);
    const text = g.children[1];
    try std.testing.expectEqualStrings("A & B A<raw>", text.text);
    try std.testing.expectEqual(@as(usize, 2), text.children.len);
    try std.testing.expectEqualStrings(text_node_name, text.children[1].name);
    var use: ?*Node = null;
    for (doc.root.children) |child| {
        if (std.mem.eql(u8, child.name, "use")) use = child;
    }
    try std.testing.expectEqualStrings("#a", use.?.attribute("href").?);
}

test "rejects unterminated and excessively deep markup" {
    const alloc = std.testing.allocator;
    try std.testing.expectError(error.InvalidSvg, parse(alloc, "<svg><g>"));
    var deep: std.ArrayList(u8) = .empty;
    defer deep.deinit(alloc);
    for (0..300) |_| try deep.appendSlice(alloc, "<g>");
    try std.testing.expectError(error.InvalidSvg, parse(alloc, deep.items));
}
