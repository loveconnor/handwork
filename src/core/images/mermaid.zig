//! Mermaid diagrams rendered to SVG markup.
//!
//! Supported diagram types: flowchart/graph (all directions, the common
//! node shapes, edge styles and labels, subgraphs), stateDiagram(-v2),
//! sequenceDiagram (participants, messages, notes, and loop/alt/opt-style
//! blocks), and pie. Other types return `error.UnsupportedImage` so callers
//! keep the source as a code block. Styling directives (classDef, style,
//! linkStyle, click) are accepted and ignored.
//!
//! Diagram source is untrusted model output: element counts and label
//! sizes are capped, and every label is XML-escaped into the SVG.

const std = @import("std");
const text_layout = @import("svg/text.zig");

const Allocator = std.mem.Allocator;

pub const Theme = enum { light, dark };

pub const Error = Allocator.Error || std.Io.Writer.Error || error{ UnsupportedImage, InvalidImage, ImageTooLarge };

const max_nodes = 400;
const max_edges = 1200;
const max_label_bytes = 400;
const max_dummy_nodes = 20_000;
const font_size: f64 = 14;
const line_height: f64 = 18;

const Palette = struct {
    node_fill: []const u8,
    node_stroke: []const u8,
    text: []const u8,
    edge: []const u8,
    cluster_fill: []const u8,
    cluster_stroke: []const u8,
    label_background: []const u8,
    note_fill: []const u8,
    note_stroke: []const u8,
    slices: []const []const u8,
};

const light_palette = Palette{
    .node_fill = "#ececff",
    .node_stroke = "#9370db",
    .text = "#333333",
    .edge = "#333333",
    .cluster_fill = "#ffffde",
    .cluster_stroke = "#aaaa33",
    .label_background = "#e8e8e8",
    .note_fill = "#fff5ad",
    .note_stroke = "#aaaa33",
    .slices = &.{ "#9370db", "#ff9f40", "#4bc0c0", "#ff6384", "#36a2eb", "#ffcd56", "#8bc34a", "#c9cbcf" },
};

const dark_palette = Palette{
    .node_fill = "#1e2235",
    .node_stroke = "#8b9cf7",
    .text = "#e6e6e6",
    .edge = "#c8ccd4",
    .cluster_fill = "#262a1e",
    .cluster_stroke = "#9a9a5a",
    .label_background = "#2b2f3a",
    .note_fill = "#3b3820",
    .note_stroke = "#9a9a5a",
    .slices = &.{ "#8b9cf7", "#f0a35e", "#5ec4c4", "#f07a90", "#5aa7e6", "#e6c45a", "#8fcf6a", "#a0a4ab" },
};

fn palette(theme: Theme) *const Palette {
    return if (theme == .dark) &dark_palette else &light_palette;
}

pub fn toSvg(alloc: Allocator, source: []const u8, theme: Theme) Error![]u8 {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const lines = try splitStatements(arena, source);
    if (lines.len == 0) return error.InvalidImage;
    const header = lines[0];
    const keyword = firstWord(header);
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    const colors = palette(theme);
    if (std.mem.eql(u8, keyword, "graph") or std.mem.eql(u8, keyword, "flowchart")) {
        var graph = try parseFlowchart(arena, header, lines[1..]);
        try renderGraph(arena, &graph, colors, &out.writer);
    } else if (std.mem.eql(u8, keyword, "stateDiagram") or std.mem.eql(u8, keyword, "stateDiagram-v2")) {
        var graph = try parseStateDiagram(arena, lines[1..]);
        try renderGraph(arena, &graph, colors, &out.writer);
    } else if (std.mem.eql(u8, keyword, "sequenceDiagram")) {
        const diagram = try parseSequence(arena, lines[1..]);
        try renderSequence(arena, diagram, colors, &out.writer);
    } else if (std.mem.eql(u8, keyword, "pie")) {
        const pie = try parsePie(arena, header, lines[1..]);
        try renderPie(pie, colors, &out.writer);
    } else {
        return error.UnsupportedImage;
    }
    return out.toOwnedSlice();
}

/// Splits source into trimmed, comment-free, non-empty statements. Front
/// matter (---) and %%{init} directives are dropped.
fn splitStatements(arena: Allocator, source: []const u8) ![][]const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    var in_front_matter = false;
    var lines = std.mem.splitScalar(u8, source, '\n');
    var first = true;
    while (lines.next()) |raw_line| {
        var line = std.mem.trim(u8, raw_line, " \t\r");
        if (first and std.mem.eql(u8, line, "---")) {
            in_front_matter = true;
            first = false;
            continue;
        }
        if (in_front_matter) {
            if (std.mem.eql(u8, line, "---")) in_front_matter = false;
            continue;
        }
        if (std.mem.indexOf(u8, line, "%%")) |comment| line = std.mem.trim(u8, line[0..comment], " \t");
        if (line.len == 0) continue;
        first = false;
        // Semicolons separate statements, except inside quotes or labels.
        var start: usize = 0;
        var depth: usize = 0;
        var quoted = false;
        for (line, 0..) |c, i| {
            switch (c) {
                '"' => quoted = !quoted,
                '[', '(', '{' => if (!quoted) {
                    depth += 1;
                },
                ']', ')', '}' => if (!quoted) {
                    depth -|= 1;
                },
                ';' => if (!quoted and depth == 0) {
                    const part = std.mem.trim(u8, line[start..i], " \t");
                    if (part.len > 0) try list.append(arena, part);
                    start = i + 1;
                },
                else => {},
            }
        }
        const rest = std.mem.trim(u8, line[start..], " \t");
        if (rest.len > 0) try list.append(arena, rest);
    }
    return list.items;
}

fn firstWord(line: []const u8) []const u8 {
    const end = std.mem.indexOfAny(u8, line, " \t") orelse line.len;
    return line[0..end];
}

// ---------------------------------------------------------------------------
// Graph model (flowcharts and state diagrams)

const Direction = enum { tb, bt, lr, rl };

const Shape = enum {
    rect,
    round,
    stadium,
    subroutine,
    cylinder,
    circle,
    double_circle,
    asymmetric,
    diamond,
    hexagon,
    parallelogram,
    parallelogram_alt,
    trapezoid,
    trapezoid_alt,
    start_dot,
    end_dot,
    bar,
};

const Node = struct {
    id: []const u8,
    label: []const u8,
    shape: Shape = .rect,
    cluster: ?usize = null,
    // Layout
    width: f64 = 0,
    height: f64 = 0,
    x: f64 = 0,
    y: f64 = 0,
    rank: usize = 0,
    order: f64 = 0,
    dummy: bool = false,
};

const LineStyle = enum { solid, dotted, thick };
const Head = enum { none, arrow, circle, cross };

const Edge = struct {
    from: usize,
    to: usize,
    label: []const u8 = "",
    style: LineStyle = .solid,
    head: Head = .arrow,
    tail: Head = .none,
    /// Node indices of the routed path (from, dummies..., to).
    route: []usize = &.{},
    /// Sideways offset (left of travel) that separates edges sharing the
    /// same two nodes.
    bend: f64 = 0,
};

const Cluster = struct {
    title: []const u8,
    parent: ?usize,
};

const Graph = struct {
    direction: Direction = .tb,
    nodes: std.ArrayList(Node) = .empty,
    edges: std.ArrayList(Edge) = .empty,
    clusters: std.ArrayList(Cluster) = .empty,
    arena: Allocator,

    fn findNode(self: *Graph, id: []const u8) ?usize {
        for (self.nodes.items, 0..) |n, i| if (!n.dummy and std.mem.eql(u8, n.id, id)) return i;
        return null;
    }

    fn ensureNode(self: *Graph, id: []const u8, cluster: ?usize) !usize {
        if (self.findNode(id)) |i| return i;
        if (self.nodes.items.len >= max_nodes) return error.ImageTooLarge;
        try self.nodes.append(self.arena, .{ .id = id, .label = id, .cluster = cluster });
        return self.nodes.items.len - 1;
    }

    fn addEdge(self: *Graph, edge: Edge) !void {
        if (self.edges.items.len >= max_edges) return error.ImageTooLarge;
        try self.edges.append(self.arena, edge);
    }
};

fn parseDirection(word: []const u8) ?Direction {
    if (std.mem.eql(u8, word, "TD") or std.mem.eql(u8, word, "TB")) return .tb;
    if (std.mem.eql(u8, word, "BT")) return .bt;
    if (std.mem.eql(u8, word, "LR")) return .lr;
    if (std.mem.eql(u8, word, "RL")) return .rl;
    return null;
}

fn parseFlowchart(arena: Allocator, header: []const u8, statements: []const []const u8) !Graph {
    var graph = Graph{ .arena = arena };
    var words = std.mem.tokenizeAny(u8, header, " \t");
    _ = words.next();
    if (words.next()) |dir| graph.direction = parseDirection(dir) orelse .tb;
    var cluster_stack: std.ArrayList(usize) = .empty;
    for (statements) |statement| {
        const word = firstWord(statement);
        const current_cluster: ?usize = if (cluster_stack.items.len > 0) cluster_stack.items[cluster_stack.items.len - 1] else null;
        if (std.mem.eql(u8, word, "subgraph")) {
            var title = std.mem.trim(u8, statement["subgraph".len..], " \t");
            // `subgraph id [Title]` shows the title; a bare id is its own title.
            if (std.mem.indexOfScalar(u8, title, '[')) |open| {
                if (std.mem.lastIndexOfScalar(u8, title, ']')) |close| {
                    if (close > open) title = title[open + 1 .. close];
                }
            }
            try graph.clusters.append(arena, .{ .title = try cleanLabel(arena, title), .parent = current_cluster });
            try cluster_stack.append(arena, graph.clusters.items.len - 1);
            continue;
        }
        if (std.mem.eql(u8, word, "end")) {
            _ = cluster_stack.pop();
            continue;
        }
        if (std.mem.eql(u8, word, "direction") or std.mem.eql(u8, word, "classDef") or std.mem.eql(u8, word, "class") or
            std.mem.eql(u8, word, "style") or std.mem.eql(u8, word, "linkStyle") or std.mem.eql(u8, word, "click") or
            std.mem.eql(u8, word, "accTitle:") or std.mem.eql(u8, word, "accDescr:") or std.mem.eql(u8, word, "title"))
        {
            continue;
        }
        try parseChain(&graph, statement, current_cluster);
    }
    if (graph.nodes.items.len == 0) return error.InvalidImage;
    return graph;
}

const Cursor = struct {
    text: []const u8,
    pos: usize = 0,

    fn skipSpaces(self: *Cursor) void {
        while (self.pos < self.text.len and (self.text[self.pos] == ' ' or self.text[self.pos] == '\t')) self.pos += 1;
    }

    fn rest(self: *const Cursor) []const u8 {
        return self.text[self.pos..];
    }

    fn done(self: *Cursor) bool {
        self.skipSpaces();
        return self.pos >= self.text.len;
    }
};

/// `A[x] & B --> C -- label --> D`
fn parseChain(graph: *Graph, statement: []const u8, cluster: ?usize) !void {
    var c = Cursor{ .text = statement };
    var previous = try parseNodeGroup(graph, &c, cluster);
    if (previous.len == 0) return;
    while (!c.done()) {
        const edge = parseEdge(&c) orelse return;
        const next = try parseNodeGroup(graph, &c, cluster);
        if (next.len == 0) return;
        for (previous) |from| for (next) |to| {
            var e = edge;
            e.from = from;
            e.to = to;
            e.label = try cleanLabel(graph.arena, edge.label);
            try graph.addEdge(e);
        };
        previous = next;
    }
}

fn isIdChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_' or c >= 0x80;
}

fn parseNodeGroup(graph: *Graph, c: *Cursor, cluster: ?usize) ![]usize {
    var list: std.ArrayList(usize) = .empty;
    while (true) {
        c.skipSpaces();
        const start = c.pos;
        while (c.pos < c.text.len and isIdChar(c.text[c.pos])) c.pos += 1;
        if (c.pos == start) break;
        const id = c.text[start..c.pos];
        const index = try graph.ensureNode(id, cluster);
        if (try parseShape(graph.arena, c)) |shaped| {
            graph.nodes.items[index].shape = shaped.shape;
            graph.nodes.items[index].label = shaped.label;
        }
        // Class shorthand `A:::name` is ignored.
        if (std.mem.startsWith(u8, c.rest(), ":::")) {
            c.pos += 3;
            while (c.pos < c.text.len and isIdChar(c.text[c.pos])) c.pos += 1;
        }
        try list.append(graph.arena, index);
        c.skipSpaces();
        if (c.pos < c.text.len and c.text[c.pos] == '&') {
            c.pos += 1;
            continue;
        }
        break;
    }
    return list.items;
}

const ShapedLabel = struct { shape: Shape, label: []const u8 };

fn parseShape(arena: Allocator, c: *Cursor) !?ShapedLabel {
    const Delimiter = struct { open: []const u8, close: []const u8, shape: Shape };
    // Longer openers first so "((" wins over "(".
    const delimiters = [_]Delimiter{
        .{ .open = "(((", .close = ")))", .shape = .double_circle },
        .{ .open = "((", .close = "))", .shape = .circle },
        .{ .open = "([", .close = "])", .shape = .stadium },
        .{ .open = "[[", .close = "]]", .shape = .subroutine },
        .{ .open = "[(", .close = ")]", .shape = .cylinder },
        .{ .open = "[/", .close = "/]", .shape = .parallelogram },
        .{ .open = "[/", .close = "\\]", .shape = .trapezoid },
        .{ .open = "[\\", .close = "\\]", .shape = .parallelogram_alt },
        .{ .open = "[\\", .close = "/]", .shape = .trapezoid_alt },
        .{ .open = "{{", .close = "}}", .shape = .hexagon },
        .{ .open = "{", .close = "}", .shape = .diamond },
        .{ .open = "[", .close = "]", .shape = .rect },
        .{ .open = "(", .close = ")", .shape = .round },
        .{ .open = ">", .close = "]", .shape = .asymmetric },
    };
    const rest = c.rest();
    for (delimiters) |d| {
        if (!std.mem.startsWith(u8, rest, d.open)) continue;
        const body_start = d.open.len;
        const close = findClose(rest, body_start, d.close) orelse continue;
        c.pos += close + d.close.len;
        return .{ .shape = d.shape, .label = try cleanLabel(arena, rest[body_start..close]) };
    }
    if (std.mem.startsWith(u8, rest, "@{")) {
        const close = std.mem.indexOfScalar(u8, rest, '}') orelse return null;
        const body = rest[2..close];
        c.pos += close + 1;
        var label: []const u8 = "";
        if (std.mem.indexOf(u8, body, "label:")) |at| {
            var v = std.mem.trim(u8, body[at + 6 ..], " \t");
            if (std.mem.indexOfScalar(u8, v, ',')) |comma| v = v[0..comma];
            label = try cleanLabel(arena, v);
        }
        return if (label.len > 0) .{ .shape = .rect, .label = label } else null;
    }
    return null;
}

/// Finds `close` after `start`, skipping quoted text.
fn findClose(text: []const u8, start: usize, close: []const u8) ?usize {
    var i = start;
    var quoted = false;
    while (i < text.len) : (i += 1) {
        if (text[i] == '"') quoted = !quoted;
        if (!quoted and std.mem.startsWith(u8, text[i..], close)) return i;
    }
    return null;
}

fn parseEdge(c: *Cursor) ?Edge {
    c.skipSpaces();
    const text = c.text;
    var i = c.pos;
    var edge = Edge{ .from = 0, .to = 0, .head = .none };
    if (i < text.len and (text[i] == '<' or ((text[i] == 'o' or text[i] == 'x') and i + 1 < text.len and (text[i + 1] == '-' or text[i + 1] == '=')))) {
        edge.tail = switch (text[i]) {
            '<' => .arrow,
            'o' => .circle,
            else => .cross,
        };
        i += 1;
    }
    const body_start = i;
    while (i < text.len and (text[i] == '-' or text[i] == '=' or text[i] == '.')) i += 1;
    if (i - body_start < 2 and !(i - body_start == 1 and i < text.len and text[i] == '>')) return null;
    var body = text[body_start..i];
    // `-- text -->` / `== text ==>` / `-. text .->` carry inline labels.
    if ((std.mem.eql(u8, body, "--") or std.mem.eql(u8, body, "==") or std.mem.eql(u8, body, "-.")) and
        i < text.len and text[i] == ' ')
    {
        const closers = [_][]const u8{ "-->", "---", "==>", "===", ".->", ".-", "--o", "--x" };
        var best: ?usize = null;
        for (closers) |closer| {
            if (std.mem.indexOfPos(u8, text, i, closer)) |at| {
                if (best == null or at < best.?) best = at;
            }
        }
        if (best) |at| {
            edge.label = std.mem.trim(u8, text[i..at], " \t");
            i = at;
            const second_start = i;
            while (i < text.len and (text[i] == '-' or text[i] == '=' or text[i] == '.')) i += 1;
            body = text[body_start..i];
            _ = second_start;
        }
    }
    edge.style = if (std.mem.indexOfScalar(u8, body, '=') != null)
        .thick
    else if (std.mem.indexOfScalar(u8, body, '.') != null)
        .dotted
    else
        .solid;
    if (i < text.len) {
        switch (text[i]) {
            '>' => {
                edge.head = .arrow;
                i += 1;
            },
            'o', 'x' => if (i + 1 >= text.len or !isIdChar(text[i + 1])) {
                edge.head = if (text[i] == 'o') .circle else .cross;
                i += 1;
            },
            else => {},
        }
    }
    c.pos = i;
    c.skipSpaces();
    if (c.pos < text.len and text[c.pos] == '|') {
        if (std.mem.indexOfScalarPos(u8, text, c.pos + 1, '|')) |close| {
            edge.label = text[c.pos + 1 .. close];
            c.pos = close + 1;
        }
    }
    return edge;
}

/// Unquotes, turns <br> into newlines, strips simple Markdown, and caps length.
fn cleanLabel(arena: Allocator, raw: []const u8) ![]const u8 {
    var text = std.mem.trim(u8, raw, " \t");
    if (text.len >= 2 and text[0] == '"' and text[text.len - 1] == '"') text = text[1 .. text.len - 1];
    if (text.len >= 2 and text[0] == '`' and text[text.len - 1] == '`') text = text[1 .. text.len - 1];
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len and out.items.len < max_label_bytes) {
        if (startsWithIgnoreCase(text[i..], "<br")) {
            const close = std.mem.indexOfScalarPos(u8, text, i, '>') orelse text.len - 1;
            try out.append(arena, '\n');
            i = close + 1;
            continue;
        }
        if (std.mem.startsWith(u8, text[i..], "\\n")) {
            try out.append(arena, '\n');
            i += 2;
            continue;
        }
        if (text[i] == '*' or text[i] == '`') {
            i += 1;
            continue;
        }
        if (std.mem.startsWith(u8, text[i..], "#quot;")) {
            try out.append(arena, '"');
            i += 6;
            continue;
        }
        try out.append(arena, text[i]);
        i += 1;
    }
    return out.items;
}

fn startsWithIgnoreCase(text: []const u8, prefix: []const u8) bool {
    return text.len >= prefix.len and std.ascii.eqlIgnoreCase(text[0..prefix.len], prefix);
}

fn parseStateDiagram(arena: Allocator, statements: []const []const u8) !Graph {
    var graph = Graph{ .arena = arena };
    var cluster_stack: std.ArrayList(usize) = .empty;
    var start_id: ?usize = null;
    var end_id: ?usize = null;
    for (statements) |statement| {
        const current_cluster: ?usize = if (cluster_stack.items.len > 0) cluster_stack.items[cluster_stack.items.len - 1] else null;
        const word = firstWord(statement);
        if (std.mem.eql(u8, word, "direction")) {
            var it = std.mem.tokenizeAny(u8, statement, " \t");
            _ = it.next();
            if (it.next()) |d| graph.direction = parseDirection(d) orelse graph.direction;
            continue;
        }
        if (std.mem.eql(u8, word, "}")) {
            _ = cluster_stack.pop();
            continue;
        }
        if (std.mem.eql(u8, word, "note") or std.mem.eql(u8, word, "classDef") or std.mem.eql(u8, word, "class") or std.mem.eql(u8, word, "end")) continue;
        if (std.mem.eql(u8, word, "state")) {
            var body = std.mem.trim(u8, statement["state".len..], " \t");
            const opens_block = std.mem.endsWith(u8, body, "{");
            if (opens_block) body = std.mem.trim(u8, body[0 .. body.len - 1], " \t");
            var label: ?[]const u8 = null;
            var id = body;
            if (body.len > 0 and body[0] == '"') {
                if (std.mem.indexOfScalarPos(u8, body, 1, '"')) |q| {
                    label = body[1..q];
                    if (std.mem.indexOf(u8, body[q..], " as ")) |as_at| id = std.mem.trim(u8, body[q + as_at + 4 ..], " \t");
                }
            } else if (std.mem.indexOf(u8, body, " as ")) |as_at| {
                label = body[0..as_at];
                id = std.mem.trim(u8, body[as_at + 4 ..], " \t");
            }
            var shape: Shape = .round;
            if (std.mem.indexOf(u8, id, "<<")) |stereo| {
                const kind = id[stereo..];
                id = std.mem.trim(u8, id[0..stereo], " \t");
                if (std.mem.indexOf(u8, kind, "choice") != null) shape = .diamond;
                if (std.mem.indexOf(u8, kind, "fork") != null or std.mem.indexOf(u8, kind, "join") != null) shape = .bar;
            }
            if (opens_block) {
                try graph.clusters.append(arena, .{ .title = try cleanLabel(arena, label orelse id), .parent = current_cluster });
                try cluster_stack.append(arena, graph.clusters.items.len - 1);
                continue;
            }
            const index = try graph.ensureNode(id, current_cluster);
            graph.nodes.items[index].shape = shape;
            graph.nodes.items[index].label = if (shape == .bar) "" else try cleanLabel(arena, label orelse id);
            continue;
        }
        // `A --> B : label` or `A : description`
        if (std.mem.indexOf(u8, statement, "-->")) |arrow| {
            const left = std.mem.trim(u8, statement[0..arrow], " \t");
            var right = std.mem.trim(u8, statement[arrow + 3 ..], " \t");
            var label: []const u8 = "";
            if (std.mem.indexOfScalar(u8, right, ':')) |colon| {
                label = std.mem.trim(u8, right[colon + 1 ..], " \t");
                right = std.mem.trim(u8, right[0..colon], " \t");
            }
            const from = try stateEndpoint(&graph, left, current_cluster, true, &start_id, &end_id);
            const to = try stateEndpoint(&graph, right, current_cluster, false, &start_id, &end_id);
            try graph.addEdge(.{ .from = from, .to = to, .label = try cleanLabel(arena, label) });
            continue;
        }
        if (std.mem.indexOfScalar(u8, statement, ':')) |colon| {
            const id = std.mem.trim(u8, statement[0..colon], " \t");
            const description = std.mem.trim(u8, statement[colon + 1 ..], " \t");
            const index = try graph.ensureNode(id, current_cluster);
            graph.nodes.items[index].shape = .round;
            const combined = try std.fmt.allocPrint(arena, "{s}\n{s}", .{ graph.nodes.items[index].label, description });
            graph.nodes.items[index].label = try cleanLabel(arena, combined);
            continue;
        }
        const index = try graph.ensureNode(std.mem.trim(u8, statement, " \t"), current_cluster);
        graph.nodes.items[index].shape = .round;
    }
    if (graph.nodes.items.len == 0) return error.InvalidImage;
    return graph;
}

fn stateEndpoint(graph: *Graph, name: []const u8, cluster: ?usize, is_source: bool, start_id: *?usize, end_id: *?usize) !usize {
    if (std.mem.eql(u8, name, "[*]")) {
        const slot = if (is_source) start_id else end_id;
        if (slot.*) |existing| return existing;
        if (graph.nodes.items.len >= max_nodes) return error.ImageTooLarge;
        try graph.nodes.append(graph.arena, .{ .id = if (is_source) "[*]start" else "[*]end", .label = "", .shape = if (is_source) .start_dot else .end_dot, .cluster = cluster });
        slot.* = graph.nodes.items.len - 1;
        return slot.*.?;
    }
    const index = try graph.ensureNode(name, cluster);
    if (graph.nodes.items[index].shape == .rect) graph.nodes.items[index].shape = .round;
    return index;
}

// ---------------------------------------------------------------------------
// Graph layout

fn labelSize(label: []const u8) struct { width: f64, height: f64 } {
    var width: f64 = 0;
    var lines: f64 = 0;
    var it = std.mem.splitScalar(u8, label, '\n');
    while (it.next()) |line| {
        width = @max(width, text_layout.measure(line, font_size));
        lines += 1;
    }
    return .{ .width = width, .height = lines * line_height };
}

fn sizeNode(node: *Node) void {
    const label = labelSize(node.label);
    const w = label.width;
    const h = label.height;
    switch (node.shape) {
        .start_dot, .end_dot => {
            node.width = 18;
            node.height = 18;
        },
        .bar => {
            node.width = 70;
            node.height = 8;
        },
        .circle, .double_circle => {
            const d = @max(w + 24, h + 24, 40);
            node.width = d;
            node.height = d;
        },
        .diamond => {
            node.width = @max(w * 1.5 + 30, 60);
            node.height = @max(h * 1.8 + 24, 50);
        },
        .hexagon => {
            node.width = w + 50;
            node.height = h + 22;
        },
        .parallelogram, .parallelogram_alt, .trapezoid, .trapezoid_alt, .asymmetric => {
            node.width = w + 50;
            node.height = h + 22;
        },
        else => {
            node.width = w + 32;
            node.height = h + 22;
        },
    }
}

fn layoutGraph(arena: Allocator, graph: *Graph) !void {
    const horizontal = graph.direction == .lr or graph.direction == .rl;
    const real_count = graph.nodes.items.len;
    for (graph.nodes.items) |*n| {
        sizeNode(n);
        // Lay out top-to-bottom and rotate afterwards for LR/RL.
        if (horizontal) std.mem.swap(f64, &n.width, &n.height);
    }

    // Break cycles by reversing back edges found in a DFS.
    const reversed = try arena.alloc(bool, graph.edges.items.len);
    @memset(reversed, false);
    {
        const state = try arena.alloc(u8, real_count); // 0 new, 1 on stack, 2 done
        @memset(state, 0);
        for (0..real_count) |root| {
            if (state[root] != 0) continue;
            try dfsMark(arena, graph, root, state, reversed);
        }
    }

    // Longest-path ranking over the acyclic orientation.
    const indegree = try arena.alloc(usize, real_count);
    @memset(indegree, 0);
    for (graph.edges.items, 0..) |e, i| {
        if (e.from == e.to) continue;
        const to = if (reversed[i]) e.from else e.to;
        indegree[to] += 1;
    }
    var queue: std.ArrayList(usize) = .empty;
    for (0..real_count) |i| if (indegree[i] == 0) try queue.append(arena, i);
    var head: usize = 0;
    while (head < queue.items.len) : (head += 1) {
        const u = queue.items[head];
        for (graph.edges.items, 0..) |e, i| {
            if (e.from == e.to) continue;
            const from = if (reversed[i]) e.to else e.from;
            const to = if (reversed[i]) e.from else e.to;
            if (from != u) continue;
            graph.nodes.items[to].rank = @max(graph.nodes.items[to].rank, graph.nodes.items[u].rank + 1);
            indegree[to] -= 1;
            if (indegree[to] == 0) try queue.append(arena, to);
        }
    }

    // Route every edge through one dummy node per skipped rank.
    var dummy_budget: usize = max_dummy_nodes;
    for (graph.edges.items, 0..) |*e, i| {
        const from = if (reversed[i]) e.to else e.from;
        const to = if (reversed[i]) e.from else e.to;
        var route: std.ArrayList(usize) = .empty;
        try route.append(arena, from);
        const r0 = graph.nodes.items[from].rank;
        const r1 = graph.nodes.items[to].rank;
        if (e.from != e.to and r1 > r0 + 1 and r1 - r0 - 1 <= dummy_budget) {
            dummy_budget -= r1 - r0 - 1;
            var r = r0 + 1;
            while (r < r1) : (r += 1) {
                try graph.nodes.append(arena, .{ .id = "", .label = "", .dummy = true, .rank = r, .width = 1, .height = 1 });
                try route.append(arena, graph.nodes.items.len - 1);
            }
        }
        try route.append(arena, to);
        if (reversed[i]) std.mem.reverse(usize, route.items);
        e.route = route.items;
    }

    // Group nodes by rank in first-appearance order.
    var max_rank: usize = 0;
    for (graph.nodes.items) |n| max_rank = @max(max_rank, n.rank);
    const ranks = try arena.alloc(std.ArrayList(usize), max_rank + 1);
    for (ranks) |*r| r.* = .empty;
    for (graph.nodes.items, 0..) |n, i| try ranks[n.rank].append(arena, i);
    for (ranks) |r| for (r.items, 0..) |n, pos| {
        graph.nodes.items[n].order = @floatFromInt(pos);
    };

    // Barycenter ordering sweeps.
    var sweep: usize = 0;
    while (sweep < 8) : (sweep += 1) {
        const downward = sweep % 2 == 0;
        var k: usize = 0;
        while (k <= max_rank) : (k += 1) {
            const rank_index = if (downward) k else max_rank - k;
            const rank = &ranks[rank_index];
            for (rank.items) |n| {
                var sum: f64 = 0;
                var count: f64 = 0;
                forEachNeighbor(graph, n, if (downward) .above else .below, &sum, &count);
                if (count > 0) graph.nodes.items[n].order = sum / count;
            }
            std.mem.sort(usize, rank.items, graph, struct {
                fn less(g: *Graph, a: usize, b: usize) bool {
                    return g.nodes.items[a].order < g.nodes.items[b].order;
                }
            }.less);
            for (rank.items, 0..) |n, pos| graph.nodes.items[n].order = @floatFromInt(pos);
        }
    }

    // Coordinates: ranks stack vertically; nodes pack horizontally, then
    // pull toward the mean x of their neighbors while keeping spacing.
    const node_gap: f64 = 30;
    // Edge labels sit between ranks; leave room for the largest one along
    // the rank axis (its width once LR/RL layouts are rotated).
    var rank_gap: f64 = 50;
    for (graph.edges.items) |e| if (e.label.len > 0) {
        const size = labelSize(e.label);
        rank_gap = @max(rank_gap, if (horizontal) size.width + 44 else size.height + 40);
    };
    var y: f64 = 0;
    for (ranks) |rank| {
        var tallest: f64 = 0;
        for (rank.items) |n| tallest = @max(tallest, graph.nodes.items[n].height);
        var x: f64 = 0;
        for (rank.items) |n| {
            const node = &graph.nodes.items[n];
            node.x = x + node.width / 2;
            node.y = y + tallest / 2;
            x += node.width + node_gap;
        }
        // Center the rank around x = 0.
        const offset = (x - node_gap) / 2;
        for (rank.items) |n| graph.nodes.items[n].x -= offset;
        y += tallest + rank_gap;
    }
    var pass: usize = 0;
    while (pass < 6) : (pass += 1) {
        const downward = pass % 2 == 0;
        var k: usize = 0;
        while (k <= max_rank) : (k += 1) {
            const rank = ranks[if (downward) k else max_rank - k];
            if (rank.items.len == 0) continue;
            const desired = try arena.alloc(f64, rank.items.len);
            for (rank.items, 0..) |n, idx| {
                var sum: f64 = 0;
                var count: f64 = 0;
                forEachNeighborX(graph, n, if (downward) .above else .below, &sum, &count);
                desired[idx] = if (count > 0) sum / count else graph.nodes.items[n].x;
            }
            // Enforce order and spacing left to right, then right to left.
            var placed = try arena.dupe(f64, desired);
            for (1..rank.items.len) |idx| {
                const a = graph.nodes.items[rank.items[idx - 1]];
                const b = graph.nodes.items[rank.items[idx]];
                placed[idx] = @max(placed[idx], placed[idx - 1] + (a.width + b.width) / 2 + node_gap);
            }
            var idx = rank.items.len - 1;
            while (idx > 0) : (idx -= 1) {
                const a = graph.nodes.items[rank.items[idx - 1]];
                const b = graph.nodes.items[rank.items[idx]];
                const limit = placed[idx] - (a.width + b.width) / 2 - node_gap;
                if (placed[idx - 1] > limit) placed[idx - 1] = limit;
                placed[idx - 1] = @max(placed[idx - 1], @min(desired[idx - 1], limit));
            }
            for (rank.items, 0..) |n, j| graph.nodes.items[n].x = placed[j];
        }
    }

    assignBends(graph);

    // Apply the requested direction.
    for (graph.nodes.items) |*n| {
        switch (graph.direction) {
            .tb => {},
            .bt => n.y = -n.y,
            .lr => {
                std.mem.swap(f64, &n.x, &n.y);
                std.mem.swap(f64, &n.width, &n.height);
            },
            .rl => {
                std.mem.swap(f64, &n.x, &n.y);
                std.mem.swap(f64, &n.width, &n.height);
                n.x = -n.x;
            },
        }
    }
}

/// Spreads edges that join the same pair of nodes (in either direction)
/// symmetrically to both sides of the straight line between them.
fn assignBends(graph: *Graph) void {
    const edges = graph.edges.items;
    for (edges, 0..) |*e, i| {
        if (e.from == e.to) continue;
        const lo = @min(e.from, e.to);
        const hi = @max(e.from, e.to);
        var count: usize = 0;
        var position: usize = 0;
        for (edges, 0..) |other, j| {
            if (other.from == other.to or @min(other.from, other.to) != lo or @max(other.from, other.to) != hi) continue;
            if (j < i) position += 1;
            count += 1;
        }
        if (count < 2) continue;
        const canonical = (@as(f64, @floatFromInt(position)) - (@as(f64, @floatFromInt(count)) - 1) / 2) * 30;
        // The normal flips with direction; keep offsets on distinct sides.
        e.bend = if (e.from == lo) canonical else -canonical;
    }
}

fn dfsMark(arena: Allocator, graph: *Graph, root: usize, state: []u8, reversed: []bool) !void {
    // Iterative DFS: stack of (node, next edge index).
    const Frame = struct { node: usize, edge: usize };
    var stack: std.ArrayList(Frame) = .empty;
    try stack.append(arena, .{ .node = root, .edge = 0 });
    state[root] = 1;
    while (stack.items.len > 0) {
        const top = &stack.items[stack.items.len - 1];
        if (top.edge >= graph.edges.items.len) {
            state[top.node] = 2;
            _ = stack.pop();
            continue;
        }
        const i = top.edge;
        top.edge += 1;
        const e = graph.edges.items[i];
        if (e.from != top.node or e.from == e.to) continue;
        switch (state[e.to]) {
            0 => {
                state[e.to] = 1;
                try stack.append(arena, .{ .node = e.to, .edge = 0 });
            },
            1 => reversed[i] = true,
            else => {},
        }
    }
}

const Side = enum { above, below };

fn forEachNeighbor(graph: *Graph, node: usize, side: Side, sum: *f64, count: *f64) void {
    const rank = graph.nodes.items[node].rank;
    for (graph.edges.items) |e| {
        for (e.route[0..e.route.len -| 1], 0..) |a, i| {
            const b = e.route[i + 1];
            const other: ?usize = if (a == node) b else if (b == node) a else null;
            const o = other orelse continue;
            const other_rank = graph.nodes.items[o].rank;
            const wanted = switch (side) {
                .above => other_rank + 1 == rank,
                .below => other_rank == rank + 1,
            };
            if (wanted) {
                sum.* += graph.nodes.items[o].order;
                count.* += 1;
            }
        }
    }
}

fn forEachNeighborX(graph: *Graph, node: usize, side: Side, sum: *f64, count: *f64) void {
    const rank = graph.nodes.items[node].rank;
    for (graph.edges.items) |e| {
        for (e.route[0..e.route.len -| 1], 0..) |a, i| {
            const b = e.route[i + 1];
            const other: ?usize = if (a == node) b else if (b == node) a else null;
            const o = other orelse continue;
            const other_rank = graph.nodes.items[o].rank;
            const wanted = switch (side) {
                .above => other_rank + 1 == rank,
                .below => other_rank == rank + 1,
            };
            if (wanted) {
                sum.* += graph.nodes.items[o].x;
                count.* += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Graph rendering

const Bounds = struct {
    min_x: f64 = std.math.inf(f64),
    min_y: f64 = std.math.inf(f64),
    max_x: f64 = -std.math.inf(f64),
    max_y: f64 = -std.math.inf(f64),

    fn include(self: *Bounds, x0: f64, y0: f64, x1: f64, y1: f64) void {
        self.min_x = @min(self.min_x, x0);
        self.min_y = @min(self.min_y, y0);
        self.max_x = @max(self.max_x, x1);
        self.max_y = @max(self.max_y, y1);
    }
};

fn renderGraph(arena: Allocator, graph: *Graph, colors: *const Palette, w: *std.Io.Writer) !void {
    try layoutGraph(arena, graph);

    // Cluster boxes wrap their members (and nested clusters).
    const ClusterBox = struct { b: Bounds = .{}, used: bool = false };
    const boxes = try arena.alloc(ClusterBox, graph.clusters.items.len);
    for (boxes) |*b| b.* = .{};
    for (graph.nodes.items) |n| {
        var cluster = n.cluster;
        while (cluster) |ci| : (cluster = graph.clusters.items[ci].parent) {
            boxes[ci].b.include(n.x - n.width / 2, n.y - n.height / 2, n.x + n.width / 2, n.y + n.height / 2);
            boxes[ci].used = true;
        }
    }
    var bounds: Bounds = .{};
    for (graph.nodes.items) |n| bounds.include(n.x - n.width / 2, n.y - n.height / 2, n.x + n.width / 2, n.y + n.height / 2);
    for (boxes) |*box| if (box.used) {
        box.b.min_x -= 16;
        box.b.max_x += 16;
        box.b.min_y -= 30;
        box.b.max_y += 14;
        bounds.include(box.b.min_x, box.b.min_y, box.b.max_x, box.b.max_y);
    };
    for (graph.edges.items) |e| if (e.label.len > 0) {
        const mid = labelPosition(graph, e);
        const size = labelSize(e.label);
        bounds.include(mid.x - size.width / 2 - 6, mid.y - size.height / 2 - 4, mid.x + size.width / 2 + 6, mid.y + size.height / 2 + 4);
    };

    const margin: f64 = 16;
    const width = bounds.max_x - bounds.min_x + 2 * margin;
    const height = bounds.max_y - bounds.min_y + 2 * margin;
    try w.print("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{d:.0}\" height=\"{d:.0}\" viewBox=\"{d:.2} {d:.2} {d:.2} {d:.2}\">", .{
        width, height, bounds.min_x - margin, bounds.min_y - margin, width, height,
    });

    for (boxes, 0..) |box, ci| if (box.used) {
        try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" rx=\"4\" fill=\"{s}\" stroke=\"{s}\"/>", .{
            box.b.min_x, box.b.min_y, box.b.max_x - box.b.min_x, box.b.max_y - box.b.min_y, colors.cluster_fill, colors.cluster_stroke,
        });
        try writeText(w, graph.clusters.items[ci].title, (box.b.min_x + box.b.max_x) / 2, box.b.min_y + 16, colors.text);
    };

    for (graph.edges.items) |e| try writeEdge(arena, w, graph, e, colors);
    for (graph.nodes.items) |n| if (!n.dummy) try writeNode(w, n, colors);
    for (graph.edges.items) |e| if (e.label.len > 0) {
        const mid = labelPosition(graph, e);
        const size = labelSize(e.label);
        try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" fill=\"{s}\"/>", .{
            mid.x - size.width / 2 - 4, mid.y - size.height / 2 - 2, size.width + 8, size.height + 4, colors.label_background,
        });
        try writeText(w, e.label, mid.x, mid.y, colors.text);
    };
    try w.writeAll("</svg>");
}

const P = struct { x: f64, y: f64 };

fn labelPosition(graph: *Graph, e: Edge) P {
    const route = e.route;
    if (route.len == 0) return .{ .x = 0, .y = 0 };
    if (route.len == 2 and e.bend != 0) {
        // Push the label outside the curve so labels of paired edges part.
        const a = graph.nodes.items[route[0]];
        const b = graph.nodes.items[route[1]];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = @max(@sqrt(dx * dx + dy * dy), 1e-9);
        const size = labelSize(e.label);
        const extent = @abs(dy / len) * size.width / 2 + @abs(dx / len) * size.height / 2 + 6;
        return bentMidpoint(a, b, e.bend + std.math.sign(e.bend) * extent);
    }
    if (route.len % 2 == 1) {
        const n = graph.nodes.items[route[route.len / 2]];
        return .{ .x = n.x, .y = n.y };
    }
    const a = graph.nodes.items[route[route.len / 2 - 1]];
    const b = graph.nodes.items[route[route.len / 2]];
    return .{ .x = (a.x + b.x) / 2, .y = (a.y + b.y) / 2 };
}

/// Point where the ray from the node center toward (tx, ty) leaves the node.
fn boundaryPoint(n: Node, tx: f64, ty: f64) P {
    const dx = tx - n.x;
    const dy = ty - n.y;
    if (dx == 0 and dy == 0) return .{ .x = n.x, .y = n.y };
    const hw = n.width / 2;
    const hh = n.height / 2;
    const t: f64 = switch (n.shape) {
        .circle, .double_circle, .start_dot, .end_dot => blk: {
            const r = @min(hw, hh);
            break :blk r / @sqrt(dx * dx + dy * dy);
        },
        .diamond => 1 / (@abs(dx) / hw + @abs(dy) / hh),
        else => @min(if (dx != 0) hw / @abs(dx) else std.math.inf(f64), if (dy != 0) hh / @abs(dy) else std.math.inf(f64)),
    };
    return .{ .x = n.x + dx * t, .y = n.y + dy * t };
}

/// Point `bend` units to the left of the travel direction from a to b,
/// halfway along.
fn bentMidpoint(a: Node, b: Node, bend: f64) P {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = @max(@sqrt(dx * dx + dy * dy), 1e-9);
    return .{ .x = (a.x + b.x) / 2 + dy / len * bend, .y = (a.y + b.y) / 2 - dx / len * bend };
}

fn writeEdge(arena: Allocator, w: *std.Io.Writer, graph: *Graph, e: Edge, colors: *const Palette) !void {
    const nodes = graph.nodes.items;
    const width: f64 = switch (e.style) {
        .thick => 3,
        else => 1.5,
    };
    const dash = if (e.style == .dotted) " stroke-dasharray=\"4 4\"" else "";
    if (e.from == e.to) {
        const n = nodes[e.from];
        const x = n.x + n.width / 2;
        try w.print("<path d=\"M{d:.2} {d:.2} C{d:.2} {d:.2} {d:.2} {d:.2} {d:.2} {d:.2}\" fill=\"none\" stroke=\"{s}\" stroke-width=\"{d}\"{s}/>", .{
            x, n.y - 6, x + 40, n.y - 30, x + 40, n.y + 30, x, n.y + 6, colors.edge, width, dash,
        });
        try writeHead(w, e.head, .{ .x = x, .y = n.y + 6 }, .{ .x = x + 10, .y = n.y + 14 }, colors.edge);
        return;
    }
    if (e.route.len == 2 and e.bend != 0) return writeBentEdge(w, nodes[e.route[0]], nodes[e.route[1]], e, colors, width, dash);
    var points: std.ArrayList(P) = .empty;
    for (e.route) |index| try points.append(arena, .{ .x = nodes[index].x, .y = nodes[index].y });
    if (points.items.len < 2) return;
    const first = nodes[e.route[0]];
    const last = nodes[e.route[e.route.len - 1]];
    points.items[0] = boundaryPoint(first, points.items[1].x, points.items[1].y);
    const n_points = points.items.len;
    points.items[n_points - 1] = boundaryPoint(last, points.items[n_points - 2].x, points.items[n_points - 2].y);
    // Leave room for the arrowheads.
    const end = points.items[n_points - 1];
    const before_end = points.items[n_points - 2];
    const start = points.items[0];
    const after_start = points.items[1];
    if (e.head != .none) points.items[n_points - 1] = moveToward(end, before_end, 6);
    if (e.tail != .none) points.items[0] = moveToward(start, after_start, 6);

    try w.print("<path d=\"M{d:.2} {d:.2}", .{ points.items[0].x, points.items[0].y });
    if (points.items.len == 2) {
        try w.print(" L{d:.2} {d:.2}", .{ points.items[1].x, points.items[1].y });
    } else {
        // Catmull-Rom through the route, as cubic Beziers.
        for (0..points.items.len - 1) |i| {
            const p0 = points.items[if (i == 0) 0 else i - 1];
            const p1 = points.items[i];
            const p2 = points.items[i + 1];
            const p3 = points.items[@min(i + 2, points.items.len - 1)];
            try w.print(" C{d:.2} {d:.2} {d:.2} {d:.2} {d:.2} {d:.2}", .{
                p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
                p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
                p2.x,                     p2.y,
            });
        }
    }
    try w.print("\" fill=\"none\" stroke=\"{s}\" stroke-width=\"{d}\"{s}/>", .{ colors.edge, width, dash });
    try writeHead(w, e.head, end, before_end, colors.edge);
    try writeHead(w, e.tail, start, after_start, colors.edge);
}

/// One of several edges between the same nodes: a quadratic curve whose
/// apex passes the bent midpoint.
fn writeBentEdge(w: *std.Io.Writer, a: Node, b: Node, e: Edge, colors: *const Palette, width: f64, dash: []const u8) !void {
    const mid = bentMidpoint(a, b, e.bend);
    // The control point sits twice as far out so the curve passes `mid`.
    const control = P{ .x = 2 * mid.x - (a.x + b.x) / 2, .y = 2 * mid.y - (a.y + b.y) / 2 };
    var start = boundaryPoint(a, control.x, control.y);
    var end = boundaryPoint(b, control.x, control.y);
    const tip = end;
    const tail = start;
    if (e.head != .none) end = moveToward(end, control, 6);
    if (e.tail != .none) start = moveToward(start, control, 6);
    try w.print("<path d=\"M{d:.2} {d:.2} Q{d:.2} {d:.2} {d:.2} {d:.2}\" fill=\"none\" stroke=\"{s}\" stroke-width=\"{d}\"{s}/>", .{
        start.x, start.y, control.x, control.y, end.x, end.y, colors.edge, width, dash,
    });
    try writeHead(w, e.head, tip, control, colors.edge);
    try writeHead(w, e.tail, tail, control, colors.edge);
}

fn moveToward(from: P, toward: P, distance: f64) P {
    const dx = toward.x - from.x;
    const dy = toward.y - from.y;
    const len = @sqrt(dx * dx + dy * dy);
    if (len <= distance) return from;
    return .{ .x = from.x + dx / len * distance, .y = from.y + dy / len * distance };
}

/// Draws a head whose tip is at `tip`, pointing away from `from`.
fn writeHead(w: *std.Io.Writer, head: Head, tip: P, from: P, color: []const u8) !void {
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const len = @sqrt(dx * dx + dy * dy);
    if (len == 0) return;
    const ux = dx / len;
    const uy = dy / len;
    switch (head) {
        .none => {},
        .arrow => {
            const bx = tip.x - ux * 10;
            const by = tip.y - uy * 10;
            try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} Z\" fill=\"{s}\"/>", .{
                tip.x, tip.y, bx - uy * 5, by + ux * 5, bx + uy * 5, by - ux * 5, color,
            });
        },
        .circle => try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"4\" fill=\"{s}\"/>", .{ tip.x - ux * 4, tip.y - uy * 4, color }),
        .cross => {
            const cx = tip.x - ux * 5;
            const cy = tip.y - uy * 5;
            try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} M{d:.2} {d:.2} L{d:.2} {d:.2}\" stroke=\"{s}\" stroke-width=\"2\"/>", .{
                cx - 4, cy - 4, cx + 4, cy + 4, cx - 4, cy + 4, cx + 4, cy - 4, color,
            });
        },
    }
}

fn writeNode(w: *std.Io.Writer, n: Node, colors: *const Palette) !void {
    const x0 = n.x - n.width / 2;
    const y0 = n.y - n.height / 2;
    const x1 = n.x + n.width / 2;
    const y1 = n.y + n.height / 2;
    const fill = colors.node_fill;
    const stroke = colors.node_stroke;
    const common = "stroke-width=\"1.5\"";
    switch (n.shape) {
        .rect => try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ x0, y0, n.width, n.height, fill, stroke, common }),
        .round => try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" rx=\"8\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ x0, y0, n.width, n.height, fill, stroke, common }),
        .stadium => try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" rx=\"{d:.2}\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ x0, y0, n.width, n.height, n.height / 2, fill, stroke, common }),
        .subroutine => {
            try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ x0, y0, n.width, n.height, fill, stroke, common });
            try w.print("<path d=\"M{d:.2} {d:.2} V{d:.2} M{d:.2} {d:.2} V{d:.2}\" stroke=\"{s}\" {s}/>", .{ x0 + 8, y0, y1, x1 - 8, y0, y1, stroke, common });
        },
        .cylinder => {
            const ry: f64 = 6;
            try w.print("<path d=\"M{d:.2} {d:.2} A{d:.2} {d:.2} 0 0 1 {d:.2} {d:.2} V{d:.2} A{d:.2} {d:.2} 0 0 1 {d:.2} {d:.2} Z\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{
                x0, y0 + ry, n.width / 2, ry, x1, y0 + ry, y1 - ry, n.width / 2, ry, x0, y1 - ry, fill, stroke, common,
            });
            try w.print("<path d=\"M{d:.2} {d:.2} A{d:.2} {d:.2} 0 0 0 {d:.2} {d:.2}\" fill=\"none\" stroke=\"{s}\" {s}/>", .{ x0, y0 + ry, n.width / 2, ry, x1, y0 + ry, stroke, common });
        },
        .circle => try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"{d:.2}\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ n.x, n.y, n.width / 2, fill, stroke, common }),
        .double_circle => {
            try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"{d:.2}\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ n.x, n.y, n.width / 2, fill, stroke, common });
            try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"{d:.2}\" fill=\"none\" stroke=\"{s}\" {s}/>", .{ n.x, n.y, n.width / 2 - 5, stroke, common });
        },
        .diamond => try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} Z\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{ n.x, y0, x1, n.y, n.x, y1, x0, n.y, fill, stroke, common }),
        .hexagon => try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} Z\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{
            x0 + 14, y0, x1 - 14, y0, x1, n.y, x1 - 14, y1, x0 + 14, y1, x0, n.y, fill, stroke, common,
        }),
        .parallelogram, .parallelogram_alt, .trapezoid, .trapezoid_alt, .asymmetric => {
            const s: f64 = 12;
            const pts: [4]P = switch (n.shape) {
                .parallelogram => .{ .{ .x = x0 + s, .y = y0 }, .{ .x = x1, .y = y0 }, .{ .x = x1 - s, .y = y1 }, .{ .x = x0, .y = y1 } },
                .parallelogram_alt => .{ .{ .x = x0, .y = y0 }, .{ .x = x1 - s, .y = y0 }, .{ .x = x1, .y = y1 }, .{ .x = x0 + s, .y = y1 } },
                .trapezoid => .{ .{ .x = x0 + s, .y = y0 }, .{ .x = x1 - s, .y = y0 }, .{ .x = x1, .y = y1 }, .{ .x = x0, .y = y1 } },
                .trapezoid_alt => .{ .{ .x = x0, .y = y0 }, .{ .x = x1, .y = y0 }, .{ .x = x1 - s, .y = y1 }, .{ .x = x0 + s, .y = y1 } },
                else => .{ .{ .x = x0, .y = y0 }, .{ .x = x1, .y = y0 }, .{ .x = x1, .y = y1 }, .{ .x = x0, .y = y1 } },
            };
            if (n.shape == .asymmetric) {
                try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} Z\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{
                    x0, y0, x1, y0, x1, y1, x0, y1, x0 + s, n.y, fill, stroke, common,
                });
            } else {
                try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} L{d:.2} {d:.2} Z\" fill=\"{s}\" stroke=\"{s}\" {s}/>", .{
                    pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y, fill, stroke, common,
                });
            }
        },
        .start_dot => try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"8\" fill=\"{s}\"/>", .{ n.x, n.y, colors.edge }),
        .end_dot => {
            try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"8\" fill=\"none\" stroke=\"{s}\" stroke-width=\"1.5\"/>", .{ n.x, n.y, colors.edge });
            try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"4.5\" fill=\"{s}\"/>", .{ n.x, n.y, colors.edge });
        },
        .bar => try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" fill=\"{s}\"/>", .{ x0, y0, n.width, n.height, colors.edge }),
    }
    if (n.label.len > 0) try writeText(w, n.label, n.x, n.y, colors.text);
}

/// Writes centered, possibly multi-line text around (x, y).
fn writeText(w: *std.Io.Writer, label: []const u8, x: f64, y: f64, color: []const u8) !void {
    var lines: usize = 0;
    var count_it = std.mem.splitScalar(u8, label, '\n');
    while (count_it.next()) |_| lines += 1;
    const first_y = y - (@as(f64, @floatFromInt(lines)) - 1) * line_height / 2;
    var it = std.mem.splitScalar(u8, label, '\n');
    var i: usize = 0;
    while (it.next()) |line| : (i += 1) {
        try w.print("<text x=\"{d:.2}\" y=\"{d:.2}\" font-size=\"{d}\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"{s}\">", .{
            x, first_y + @as(f64, @floatFromInt(i)) * line_height, font_size, color,
        });
        try writeEscaped(w, line);
        try w.writeAll("</text>");
    }
}

fn writeEscaped(w: *std.Io.Writer, text: []const u8) !void {
    for (text) |c| switch (c) {
        '<' => try w.writeAll("&lt;"),
        '>' => try w.writeAll("&gt;"),
        '&' => try w.writeAll("&amp;"),
        '"' => try w.writeAll("&quot;"),
        else => try w.writeByte(c),
    };
}

// ---------------------------------------------------------------------------
// Sequence diagrams

const Participant = struct { id: []const u8, label: []const u8, actor: bool };

const Arrow = struct { dotted: bool, head: enum { none, arrow, cross, open } };

const NoteSide = enum { left, right, over };

const SequenceItem = union(enum) {
    message: struct { from: usize, to: usize, label: []const u8, arrow: Arrow },
    note: struct { first: usize, last: usize, side: NoteSide, label: []const u8 },
    block_start: struct { kind: []const u8, label: []const u8 },
    block_divider: struct { label: []const u8 },
    block_end,
};

const Sequence = struct {
    participants: std.ArrayList(Participant) = .empty,
    items: std.ArrayList(SequenceItem) = .empty,
    autonumber: bool = false,
};

fn participantIndex(arena: Allocator, seq: *Sequence, id: []const u8) !usize {
    for (seq.participants.items, 0..) |p, i| if (std.mem.eql(u8, p.id, id)) return i;
    if (seq.participants.items.len >= 64) return error.ImageTooLarge;
    try seq.participants.append(arena, .{ .id = id, .label = id, .actor = false });
    return seq.participants.items.len - 1;
}

fn parseSequence(arena: Allocator, statements: []const []const u8) !Sequence {
    var seq: Sequence = .{};
    const arrows = [_]struct { token: []const u8, arrow: Arrow }{
        .{ .token = "-->>", .arrow = .{ .dotted = true, .head = .arrow } },
        .{ .token = "->>", .arrow = .{ .dotted = false, .head = .arrow } },
        .{ .token = "--x", .arrow = .{ .dotted = true, .head = .cross } },
        .{ .token = "-x", .arrow = .{ .dotted = false, .head = .cross } },
        .{ .token = "--)", .arrow = .{ .dotted = true, .head = .open } },
        .{ .token = "-)", .arrow = .{ .dotted = false, .head = .open } },
        .{ .token = "-->", .arrow = .{ .dotted = true, .head = .none } },
        .{ .token = "->", .arrow = .{ .dotted = false, .head = .none } },
    };
    for (statements) |statement| {
        if (seq.items.items.len >= 1000) return error.ImageTooLarge;
        const word = firstWord(statement);
        if (std.mem.eql(u8, word, "participant") or std.mem.eql(u8, word, "actor")) {
            const body = std.mem.trim(u8, statement[word.len..], " \t");
            var id = body;
            var label = body;
            if (std.mem.indexOf(u8, body, " as ")) |as_at| {
                id = std.mem.trim(u8, body[0..as_at], " \t");
                label = std.mem.trim(u8, body[as_at + 4 ..], " \t");
            }
            const index = try participantIndex(arena, &seq, id);
            seq.participants.items[index].label = try cleanLabel(arena, label);
            seq.participants.items[index].actor = std.mem.eql(u8, word, "actor");
            continue;
        }
        if (std.mem.eql(u8, word, "autonumber")) {
            seq.autonumber = true;
            continue;
        }
        if (std.mem.eql(u8, word, "activate") or std.mem.eql(u8, word, "deactivate") or std.mem.eql(u8, word, "title") or
            std.mem.eql(u8, word, "box") or std.mem.eql(u8, word, "create") or std.mem.eql(u8, word, "destroy")) continue;
        const block_words = [_][]const u8{ "loop", "alt", "opt", "par", "critical", "break", "rect" };
        var is_block = false;
        for (block_words) |b| if (std.mem.eql(u8, word, b)) {
            is_block = true;
        };
        if (is_block) {
            try seq.items.append(arena, .{ .block_start = .{ .kind = word, .label = try cleanLabel(arena, std.mem.trim(u8, statement[word.len..], " \t")) } });
            continue;
        }
        if (std.mem.eql(u8, word, "else") or std.mem.eql(u8, word, "and") or std.mem.eql(u8, word, "option")) {
            try seq.items.append(arena, .{ .block_divider = .{ .label = try cleanLabel(arena, std.mem.trim(u8, statement[word.len..], " \t")) } });
            continue;
        }
        if (std.mem.eql(u8, word, "end")) {
            try seq.items.append(arena, .block_end);
            continue;
        }
        if (startsWithIgnoreCase(statement, "note ")) {
            const colon = std.mem.indexOfScalar(u8, statement, ':') orelse continue;
            const where = std.mem.trim(u8, statement[5..colon], " \t");
            const label = try cleanLabel(arena, statement[colon + 1 ..]);
            var side: NoteSide = .over;
            var targets = where;
            if (startsWithIgnoreCase(where, "left of ")) {
                side = .left;
                targets = where[8..];
            } else if (startsWithIgnoreCase(where, "right of ")) {
                side = .right;
                targets = where[9..];
            } else if (startsWithIgnoreCase(where, "over ")) {
                targets = where[5..];
            }
            var it = std.mem.tokenizeAny(u8, targets, ", \t");
            const first = try participantIndex(arena, &seq, it.next() orelse continue);
            const last = if (it.next()) |second| try participantIndex(arena, &seq, second) else first;
            try seq.items.append(arena, .{ .note = .{ .first = @min(first, last), .last = @max(first, last), .side = side, .label = label } });
            continue;
        }
        // Messages: A->>B: text
        const colon = std.mem.indexOfScalar(u8, statement, ':') orelse statement.len;
        const head = statement[0..colon];
        for (arrows) |a| {
            const at = std.mem.indexOf(u8, head, a.token) orelse continue;
            const from = std.mem.trim(u8, head[0..at], " \t");
            var to = std.mem.trim(u8, head[at + a.token.len ..], " \t");
            to = std.mem.trimStart(u8, to, "+-");
            if (from.len == 0 or to.len == 0) break;
            const label = if (colon < statement.len) statement[colon + 1 ..] else "";
            try seq.items.append(arena, .{ .message = .{
                .from = try participantIndex(arena, &seq, from),
                .to = try participantIndex(arena, &seq, to),
                .label = try cleanLabel(arena, label),
                .arrow = a.arrow,
            } });
            break;
        }
    }
    if (seq.participants.items.len == 0) return error.InvalidImage;
    return seq;
}

fn renderSequence(arena: Allocator, seq: Sequence, colors: *const Palette, w: *std.Io.Writer) !void {
    const count = seq.participants.items.len;
    const box_height: f64 = 36;
    // Column widths fit participant labels and the messages between them.
    const box_widths = try arena.alloc(f64, count);
    for (seq.participants.items, 0..) |p, i| box_widths[i] = @max(labelSize(p.label).width + 30, 80);
    const gaps = try arena.alloc(f64, count);
    @memset(gaps, 60);
    for (seq.items.items) |item| switch (item) {
        .message => |m| if (m.from != m.to) {
            const lo = @min(m.from, m.to);
            const hi = @max(m.from, m.to);
            const needed = labelSize(m.label).width + 30;
            const span: f64 = @floatFromInt(hi - lo);
            for (lo..hi) |g| gaps[g] = @max(gaps[g], needed / span - (box_widths[g] + box_widths[g + 1]) / 2 + 20);
        },
        else => {},
    };
    const centers = try arena.alloc(f64, count);
    var x: f64 = box_widths[0] / 2;
    for (0..count) |i| {
        if (i > 0) x += box_widths[i - 1] / 2 + gaps[i - 1] + box_widths[i] / 2;
        centers[i] = x;
    }

    // First pass: vertical positions of every item.
    var y: f64 = box_height + 30;
    const item_y = try arena.alloc(f64, seq.items.items.len);
    var right_edge: f64 = centers[count - 1] + box_widths[count - 1] / 2;
    for (seq.items.items, 0..) |item, i| {
        switch (item) {
            .message => |m| {
                const label_h = labelSize(m.label).height;
                y += label_h + 6;
                item_y[i] = y;
                y += if (m.from == m.to) 40 else 24;
                if (m.from == m.to) right_edge = @max(right_edge, centers[m.from] + 50 + labelSize(m.label).width);
            },
            .note => |n| {
                item_y[i] = y;
                y += labelSize(n.label).height + 24;
            },
            .block_start, .block_divider => {
                item_y[i] = y;
                y += 28;
            },
            .block_end => {
                item_y[i] = y;
                y += 12;
            },
        }
    }
    const bottom = y + 10;
    const width = right_edge + 40;
    const height = bottom + box_height + 20;
    try w.print("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{d:.0}\" height=\"{d:.0}\" viewBox=\"-20 -10 {d:.2} {d:.2}\">", .{ width, height, width, height });

    // Lifelines and participant boxes (top and bottom).
    for (seq.participants.items, 0..) |p, i| {
        try w.print("<line x1=\"{d:.2}\" y1=\"{d:.2}\" x2=\"{d:.2}\" y2=\"{d:.2}\" stroke=\"{s}\" stroke-width=\"1\" stroke-dasharray=\"3 3\"/>", .{ centers[i], box_height, centers[i], bottom, colors.edge });
        for ([_]f64{ 0, bottom }) |top| {
            try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" rx=\"3\" fill=\"{s}\" stroke=\"{s}\" stroke-width=\"1.5\"/>", .{
                centers[i] - box_widths[i] / 2, top, box_widths[i], box_height, colors.node_fill, colors.node_stroke,
            });
            try writeText(w, p.label, centers[i], top + box_height / 2, colors.text);
        }
    }

    // Blocks are drawn behind messages, so emit their frames first.
    var block_stack: std.ArrayList(usize) = .empty;
    for (seq.items.items, 0..) |item, i| switch (item) {
        .block_start => try block_stack.append(arena, i),
        .block_end => if (block_stack.pop()) |start| {
            const kind = seq.items.items[start].block_start.kind;
            const label = seq.items.items[start].block_start.label;
            const top = item_y[start];
            const left = centers[0] - box_widths[0] / 2 + 6;
            const right = right_edge - 6;
            try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" fill=\"none\" stroke=\"{s}\" stroke-width=\"1\"/>", .{ left, top, right - left, item_y[i] - top, colors.cluster_stroke });
            const tag = try std.fmt.allocPrint(arena, "{s} {s}", .{ kind, label });
            try w.print("<text x=\"{d:.2}\" y=\"{d:.2}\" font-size=\"12\" fill=\"{s}\">", .{ left + 6, top + 16, colors.text });
            try writeEscaped(w, tag);
            try w.writeAll("</text>");
        },
        .block_divider => |d| {
            const left = centers[0] - box_widths[0] / 2 + 6;
            try w.print("<line x1=\"{d:.2}\" y1=\"{d:.2}\" x2=\"{d:.2}\" y2=\"{d:.2}\" stroke=\"{s}\" stroke-dasharray=\"4 3\"/>", .{ left, item_y[i], right_edge - 6, item_y[i], colors.cluster_stroke });
            if (d.label.len > 0) {
                try w.print("<text x=\"{d:.2}\" y=\"{d:.2}\" font-size=\"12\" fill=\"{s}\">", .{ left + 6, item_y[i] + 16, colors.text });
                try writeEscaped(w, d.label);
                try w.writeAll("</text>");
            }
        },
        else => {},
    };

    var number: usize = 0;
    for (seq.items.items, 0..) |item, i| switch (item) {
        .message => |m| {
            number += 1;
            const label = if (seq.autonumber) try std.fmt.allocPrint(arena, "{d}. {s}", .{ number, m.label }) else m.label;
            const dash = if (m.arrow.dotted) " stroke-dasharray=\"4 3\"" else "";
            const my = item_y[i];
            if (m.from == m.to) {
                const cx = centers[m.from];
                try w.print("<path d=\"M{d:.2} {d:.2} H{d:.2} V{d:.2} H{d:.2}\" fill=\"none\" stroke=\"{s}\" stroke-width=\"1.5\"{s}/>", .{ cx, my, cx + 36, my + 22, cx + 4, colors.edge, dash });
                try writeSequenceHead(w, m.arrow, .{ .x = cx + 2, .y = my + 22 }, .{ .x = cx + 36, .y = my + 22 }, colors.edge);
                if (label.len > 0) try writeLabelAbove(w, label, cx + 42 + labelSize(label).width / 2, my + 8, colors.text);
                continue;
            }
            const x0 = centers[m.from];
            const x1 = centers[m.to];
            const tip_x = if (x1 > x0) x1 - 2 else x1 + 2;
            try w.print("<line x1=\"{d:.2}\" y1=\"{d:.2}\" x2=\"{d:.2}\" y2=\"{d:.2}\" stroke=\"{s}\" stroke-width=\"1.5\"{s}/>", .{ x0, my, tip_x, my, colors.edge, dash });
            try writeSequenceHead(w, m.arrow, .{ .x = tip_x, .y = my }, .{ .x = x0, .y = my }, colors.edge);
            if (label.len > 0) try writeLabelAbove(w, label, (x0 + x1) / 2, my - 4, colors.text);
        },
        .note => |n| {
            const size = labelSize(n.label);
            const note_w = @max(size.width + 20, 60);
            const cx: f64 = switch (n.side) {
                .left => centers[n.first] - box_widths[n.first] / 2 - note_w / 2 + 20,
                .right => centers[n.first] + box_widths[n.first] / 2 + note_w / 2 - 20,
                .over => (centers[n.first] + centers[n.last]) / 2,
            };
            const span_w = if (n.side == .over and n.last != n.first) @max(note_w, centers[n.last] - centers[n.first] + 40) else note_w;
            try w.print("<rect x=\"{d:.2}\" y=\"{d:.2}\" width=\"{d:.2}\" height=\"{d:.2}\" fill=\"{s}\" stroke=\"{s}\"/>", .{
                cx - span_w / 2, item_y[i], span_w, size.height + 12, colors.note_fill, colors.note_stroke,
            });
            try writeText(w, n.label, cx, item_y[i] + (size.height + 12) / 2, colors.text);
        },
        else => {},
    };
    try w.writeAll("</svg>");
}

fn writeLabelAbove(w: *std.Io.Writer, label: []const u8, x: f64, baseline_y: f64, color: []const u8) !void {
    var lines: usize = 0;
    var count_it = std.mem.splitScalar(u8, label, '\n');
    while (count_it.next()) |_| lines += 1;
    var it = std.mem.splitScalar(u8, label, '\n');
    var i: usize = 0;
    while (it.next()) |line| : (i += 1) {
        const y = baseline_y - @as(f64, @floatFromInt(lines - 1 - i)) * line_height;
        try w.print("<text x=\"{d:.2}\" y=\"{d:.2}\" font-size=\"{d}\" text-anchor=\"middle\" fill=\"{s}\">", .{ x, y, font_size, color });
        try writeEscaped(w, line);
        try w.writeAll("</text>");
    }
}

fn writeSequenceHead(w: *std.Io.Writer, arrow: Arrow, tip: P, from: P, color: []const u8) !void {
    switch (arrow.head) {
        .none => {},
        .arrow => try writeHead(w, .arrow, tip, from, color),
        .cross => try writeHead(w, .cross, tip, from, color),
        .open => {
            const dir: f64 = if (tip.x > from.x) 1 else -1;
            try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} M{d:.2} {d:.2} L{d:.2} {d:.2}\" stroke=\"{s}\" stroke-width=\"1.5\"/>", .{
                tip.x, tip.y, tip.x - dir * 9, tip.y - 5, tip.x, tip.y, tip.x - dir * 9, tip.y + 5, color,
            });
        },
    }
}

// ---------------------------------------------------------------------------
// Pie charts

const Slice = struct { label: []const u8, value: f64 };

const Pie = struct {
    title: []const u8 = "",
    slices: std.ArrayList(Slice) = .empty,
    show_data: bool = false,
};

fn parsePie(arena: Allocator, header: []const u8, statements: []const []const u8) !Pie {
    var pie: Pie = .{};
    var rest = std.mem.trim(u8, header["pie".len..], " \t");
    if (std.mem.startsWith(u8, rest, "showData")) {
        pie.show_data = true;
        rest = std.mem.trim(u8, rest["showData".len..], " \t");
    }
    if (std.mem.startsWith(u8, rest, "title")) pie.title = try cleanLabel(arena, rest["title".len..]);
    for (statements) |statement| {
        if (std.mem.startsWith(u8, statement, "title")) {
            pie.title = try cleanLabel(arena, statement["title".len..]);
            continue;
        }
        if (std.mem.eql(u8, statement, "showData")) {
            pie.show_data = true;
            continue;
        }
        const colon = std.mem.lastIndexOfScalar(u8, statement, ':') orelse continue;
        const value = std.fmt.parseFloat(f64, std.mem.trim(u8, statement[colon + 1 ..], " \t")) catch continue;
        if (!(value > 0) or !std.math.isFinite(value)) continue;
        if (pie.slices.items.len >= 64) return error.ImageTooLarge;
        try pie.slices.append(arena, .{ .label = try cleanLabel(arena, statement[0..colon]), .value = value });
    }
    if (pie.slices.items.len == 0) return error.InvalidImage;
    return pie;
}

fn legendSuffix(buf: []u8, value: f64, total: f64, show_data: bool) []const u8 {
    const percent = value / total * 100;
    return if (show_data)
        std.fmt.bufPrint(buf, " [{d}] ({d:.1}%)", .{ value, percent }) catch ""
    else
        std.fmt.bufPrint(buf, " ({d:.1}%)", .{percent}) catch "";
}

fn renderPie(pie: Pie, colors: *const Palette, w: *std.Io.Writer) !void {
    var total: f64 = 0;
    for (pie.slices.items) |s| total += s.value;
    const radius: f64 = 110;
    const cx: f64 = 130;
    const title_h: f64 = if (pie.title.len > 0) 34 else 0;
    const cy: f64 = 130 + title_h;
    var legend_w: f64 = 0;
    var buf: [64]u8 = undefined;
    for (pie.slices.items) |s| {
        const suffix = legendSuffix(&buf, s.value, total, pie.show_data);
        legend_w = @max(legend_w, text_layout.measure(s.label, font_size) + text_layout.measure(suffix, font_size));
    }
    const legend_h = @as(f64, @floatFromInt(pie.slices.items.len)) * 24;
    const width = 280 + legend_w + 50;
    const height = @max(260 + title_h, legend_h + title_h + 40);
    try w.print("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{d:.0}\" height=\"{d:.0}\">", .{ width, height });
    if (pie.title.len > 0) try writeText(w, pie.title, width / 2, 18, colors.text);
    var angle: f64 = -std.math.pi / 2.0;
    for (pie.slices.items, 0..) |s, i| {
        const color = colors.slices[i % colors.slices.len];
        const sweep = s.value / total * 2 * std.math.pi;
        if (pie.slices.items.len == 1) {
            try w.print("<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"{d:.2}\" fill=\"{s}\"/>", .{ cx, cy, radius, color });
        } else {
            const x0 = cx + radius * @cos(angle);
            const y0 = cy + radius * @sin(angle);
            const x1 = cx + radius * @cos(angle + sweep);
            const y1 = cy + radius * @sin(angle + sweep);
            const large: u8 = if (sweep > std.math.pi) 1 else 0;
            try w.print("<path d=\"M{d:.2} {d:.2} L{d:.2} {d:.2} A{d:.2} {d:.2} 0 {d} 1 {d:.2} {d:.2} Z\" fill=\"{s}\" stroke=\"{s}\" stroke-width=\"1\"/>", .{
                cx, cy, x0, y0, radius, radius, large, x1, y1, color, colors.node_fill,
            });
        }
        angle += sweep;
        const ly = title_h + 40 + @as(f64, @floatFromInt(i)) * 24;
        try w.print("<rect x=\"270\" y=\"{d:.2}\" width=\"14\" height=\"14\" fill=\"{s}\"/>", .{ ly - 7, color });
        const legend = legendSuffix(&buf, s.value, total, pie.show_data);
        try w.print("<text x=\"292\" y=\"{d:.2}\" font-size=\"{d}\" dominant-baseline=\"middle\" fill=\"{s}\">", .{ ly, font_size, colors.text });
        try writeEscaped(w, s.label);
        try writeEscaped(w, legend);
        try w.writeAll("</text>");
    }
    try w.writeAll("</svg>");
}

test "flowcharts parse shapes, chains, groups, labels, and subgraphs" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const statements = try splitStatements(arena,
        \\flowchart LR
        \\  %% comment
        \\  A[Start] --> B{Is it?}
        \\  B -- Yes --> C([Done]) & D((Circle))
        \\  B -.->|No| A
        \\  subgraph group [Group title]
        \\    E[["Sub <br> routine"]] ==> F[(DB)]
        \\  end
        \\  classDef x fill:#f00; class A x
    );
    var graph = try parseFlowchart(arena, statements[0], statements[1..]);
    try std.testing.expectEqual(Direction.lr, graph.direction);
    try std.testing.expectEqual(@as(usize, 6), graph.nodes.items.len);
    try std.testing.expectEqual(Shape.diamond, graph.nodes.items[graph.findNode("B").?].shape);
    try std.testing.expectEqual(Shape.stadium, graph.nodes.items[graph.findNode("C").?].shape);
    try std.testing.expectEqual(Shape.circle, graph.nodes.items[graph.findNode("D").?].shape);
    const e = graph.nodes.items[graph.findNode("E").?];
    try std.testing.expectEqualStrings("Sub \n routine", e.label);
    try std.testing.expect(e.cluster != null);
    try std.testing.expectEqual(@as(usize, 5), graph.edges.items.len);
    try std.testing.expectEqualStrings("Yes", graph.edges.items[1].label);
    try std.testing.expectEqualStrings("No", graph.edges.items[3].label);
    try std.testing.expectEqual(LineStyle.dotted, graph.edges.items[3].style);
    try std.testing.expectEqual(LineStyle.thick, graph.edges.items[4].style);
}

test "every supported diagram type renders to parseable SVG" {
    const alloc = std.testing.allocator;
    const xml = @import("svg/xml.zig");
    const sources = [_][]const u8{
        "graph TD\nA-->B\nB-->C\nC-->A\nA-->C",
        "stateDiagram-v2\n[*] --> Still\nStill --> Moving : push\nMoving --> [*]\nstate Moving {\n  Slow --> Fast\n}",
        "sequenceDiagram\nparticipant A as Alice\nA->>B: Hi <b>Bob</b>\nloop Every minute\nB-->>A: Fine & you?\nend\nNote over A,B: done",
        "pie title Pets\n\"Dogs\" : 386\n\"Cats\" : 85",
    };
    for (sources) |source| {
        for ([_]Theme{ .light, .dark }) |theme| {
            const svg = try toSvg(alloc, source, theme);
            defer alloc.free(svg);
            var doc = try xml.parse(alloc, svg);
            defer doc.deinit();
            try std.testing.expectEqualStrings("svg", doc.root.name);
        }
    }
    try std.testing.expectError(error.UnsupportedImage, toSvg(alloc, "gantt\ntitle X", .light));
}

test "layout puts edge targets on later ranks and keeps nodes apart" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const statements = try splitStatements(arena, "graph TD\nA-->B\nA-->C\nB-->D\nC-->D\nD-->A");
    var graph = try parseFlowchart(arena, statements[0], statements[1..]);
    try layoutGraph(arena, &graph);
    const a = graph.nodes.items[graph.findNode("A").?];
    const b = graph.nodes.items[graph.findNode("B").?];
    const c = graph.nodes.items[graph.findNode("C").?];
    const d = graph.nodes.items[graph.findNode("D").?];
    try std.testing.expect(a.y < b.y and b.y < d.y);
    try std.testing.expect(@abs(b.x - c.x) >= (b.width + c.width) / 2);
}
