//! Chooses how inline images reach the terminal.
//!
//! Environment facts decide first (an explicit HANDWORK_IMAGES override,
//! then terminals known by their own variables). Only when those are
//! inconclusive does startup probe the terminal; the probe answers are
//! parsed here so the policy stays testable without a terminal.

const std = @import("std");

pub const Protocol = enum {
    /// Kitty graphics with Unicode placeholders (kitty, Ghostty).
    kitty,
    /// iTerm2 OSC 1337 inline images (iTerm2, WezTerm).
    iterm2,
    /// DEC SIXEL (Windows Terminal, xterm, foot, VS Code with images on).
    sixel,
    /// Unicode half blocks; needs only color.
    blocks,
    /// Images are not drawn; Handwork shows its text fallback.
    none,

    pub fn drawsPixelsOutOfBand(self: Protocol) bool {
        return self == .iterm2 or self == .sixel;
    }

    pub fn usesPlaceholderCells(self: Protocol) bool {
        return self == .kitty or self.drawsPixelsOutOfBand();
    }

    /// SIXEL draws real pixels at the cursor, so a wrong cell size would
    /// spill over neighboring text. The other protocols scale to cells.
    pub fn requiresExactCellSize(self: Protocol) bool {
        return self == .sixel;
    }

    pub fn parse(value: []const u8) ?Protocol {
        inline for (@typeInfo(Protocol).@"enum".fields) |field| {
            if (std.ascii.eqlIgnoreCase(value, field.name)) return @enumFromInt(field.value);
        }
        if (std.ascii.eqlIgnoreCase(value, "off") or std.ascii.eqlIgnoreCase(value, "0") or
            std.ascii.eqlIgnoreCase(value, "false")) return .none;
        if (std.ascii.eqlIgnoreCase(value, "iterm")) return .iterm2;
        return null;
    }
};

pub const CellSize = struct {
    width_px: u16,
    height_px: u16,

    pub fn isKnown(self: CellSize) bool {
        return self.width_px > 0 and self.height_px > 0;
    }

    /// Used only for aspect-ratio layout when the terminal does not say.
    pub const assumed: CellSize = .{ .width_px = 9, .height_px = 18 };
};

pub const Environment = struct {
    handwork_images: ?[]const u8 = null,
    term: ?[]const u8 = null,
    term_program: ?[]const u8 = null,
    kitty_window_id: ?[]const u8 = null,
    wt_session: ?[]const u8 = null,
    tmux: ?[]const u8 = null,
    konsole_version: ?[]const u8 = null,
    is_windows: bool = false,
};

pub const EnvironmentDecision = union(enum) {
    decided: Protocol,
    /// Probe the terminal; `fallback` applies when probes are inconclusive.
    probe: struct { fallback: Protocol },
};

pub fn decideFromEnvironment(env: Environment) EnvironmentDecision {
    if (env.handwork_images) |value| {
        if (Protocol.parse(value)) |forced| return .{ .decided = forced };
    }
    // Multiplexers need passthrough wrapping and per-pane bookkeeping that
    // Handwork does not implement; text blocks survive them intact.
    if (env.tmux != null) return .{ .decided = .blocks };
    if (env.term) |term| {
        if (std.mem.startsWith(u8, term, "screen")) return .{ .decided = .blocks };
    }
    // VS Code can inherit KITTY_WINDOW_ID from the shell that launched it.
    // Its own terminal identity takes precedence, including on Windows.
    if (env.term_program) |program| {
        if (std.ascii.eqlIgnoreCase(program, "vscode")) return .{ .probe = .{ .fallback = .blocks } };
    }
    if (env.term) |term| {
        if (std.mem.eql(u8, term, "xterm-kitty") or std.mem.eql(u8, term, "xterm-ghostty")) return .{ .decided = .kitty };
    }
    if (env.kitty_window_id != null) return .{ .decided = .kitty };
    if (env.term_program) |program| {
        if (std.ascii.eqlIgnoreCase(program, "ghostty")) return .{ .decided = .kitty };
        if (std.mem.eql(u8, program, "iTerm.app")) return .{ .decided = .iterm2 };
        if (std.mem.eql(u8, program, "WezTerm")) return .{ .decided = .iterm2 };
        if (std.mem.eql(u8, program, "Apple_Terminal")) return .{ .decided = .blocks };
    }
    // Windows Terminal added SIXEL in 1.22; older builds answer DA1 without it.
    if (env.wt_session != null) return .{ .probe = .{ .fallback = .blocks } };
    // The legacy Windows console host never answers terminal queries.
    if (env.is_windows) return .{ .decided = .blocks };
    return .{ .probe = .{ .fallback = .blocks } };
}

pub const ProbeFacts = struct {
    kitty_graphics: bool = false,
    sixel: bool = false,
    cell: CellSize = .{ .width_px = 0, .height_px = 0 },
    window: CellSize = .{ .width_px = 0, .height_px = 0 },
    device_attributes_seen: bool = false,
};

pub const kitty_query_id: u32 = 31;

/// XTSMGRAPHICS detects image add-ons that report SIXEL
/// geometry even when DA1 does not advertise attribute 4. An early DA1 can
/// precede add-on activation, so it alone does not complete detection.
pub const probe_query = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\" ++ "\x1b[16t" ++ "\x1b[14t" ++ "\x1b[?2;1;0S" ++ "\x1b[c";

/// Parses every complete reply found in `bytes`.
pub fn parseProbeReplies(bytes: []const u8) ProbeFacts {
    var facts: ProbeFacts = .{};
    var i: usize = 0;
    while (std.mem.findScalarPos(u8, bytes, i, 0x1b)) |esc| {
        i = esc + 1;
        if (esc + 1 >= bytes.len) break;
        switch (bytes[esc + 1]) {
            '_' => {
                const end = std.mem.findPos(u8, bytes, esc + 2, "\x1b\\") orelse break;
                const body = bytes[esc + 2 .. end];
                if (std.mem.startsWith(u8, body, "Gi=31") and std.mem.endsWith(u8, body, ";OK")) {
                    facts.kitty_graphics = true;
                }
                i = end + 2;
            },
            '[' => {
                var j = esc + 2;
                while (j < bytes.len and (bytes[j] < 0x40 or bytes[j] > 0x7e)) : (j += 1) {}
                if (j >= bytes.len) break;
                const params = bytes[esc + 2 .. j];
                switch (bytes[j]) {
                    'S' => {
                        var it = std.mem.splitScalar(u8, params, ';');
                        const item = it.next() orelse "";
                        const status = it.next() orelse "";
                        const width = std.fmt.parseInt(u32, it.next() orelse "", 10) catch 0;
                        const height = std.fmt.parseInt(u32, it.next() orelse "", 10) catch 0;
                        if (std.mem.eql(u8, item, "?2") and std.mem.eql(u8, status, "0") and width > 0 and height > 0) facts.sixel = true;
                    },
                    'c' => if (params.len > 0 and params[0] == '?') {
                        facts.device_attributes_seen = true;
                        var it = std.mem.splitScalar(u8, params[1..], ';');
                        while (it.next()) |attribute| {
                            if (std.mem.eql(u8, attribute, "4")) facts.sixel = true;
                        }
                    },
                    't' => {
                        var it = std.mem.splitScalar(u8, params, ';');
                        const kind = it.next() orelse "";
                        const height = std.fmt.parseInt(u16, it.next() orelse "", 10) catch 0;
                        const width = std.fmt.parseInt(u16, it.next() orelse "", 10) catch 0;
                        if (std.mem.eql(u8, kind, "6")) facts.cell = .{ .width_px = width, .height_px = height };
                        if (std.mem.eql(u8, kind, "4")) facts.window = .{ .width_px = width, .height_px = height };
                    },
                    else => {},
                }
                i = j + 1;
            },
            else => {},
        }
    }
    return facts;
}

pub fn chooseFromProbe(env: Environment, facts: ProbeFacts, fallback: Protocol) Protocol {
    // VS Code's image add-on can acknowledge Kitty queries without drawing
    // Unicode placeholders. Use its documented SIXEL path.
    if (env.term_program) |program| {
        if (std.ascii.eqlIgnoreCase(program, "vscode")) return if (facts.sixel) .sixel else fallback;
    }
    // Konsole answers the kitty query but does not draw Unicode placeholders.
    if (facts.kitty_graphics and env.konsole_version == null) return .kitty;
    if (facts.sixel) return .sixel;
    return fallback;
}

pub fn probeComplete(env: Environment, facts: ProbeFacts, kernel_pixels_known: bool) bool {
    if (!facts.device_attributes_seen) return false;
    const chosen = chooseFromProbe(env, facts, .blocks);
    if (chosen == .blocks) return false;
    return !chosen.requiresExactCellSize() or kernel_pixels_known or facts.cell.isKnown() or facts.window.isKnown();
}

/// Cell size from the most direct source available: the kernel's pixel
/// winsize, then a CSI 16t reply, then the CSI 14t window size divided by
/// the grid size.
pub fn resolveCellSize(winsize_px: CellSize, cols: u16, rows: u16, facts: ProbeFacts) CellSize {
    if (winsize_px.isKnown() and cols > 0 and rows > 0) {
        return .{ .width_px = winsize_px.width_px / cols, .height_px = winsize_px.height_px / rows };
    }
    if (facts.cell.isKnown()) return facts.cell;
    if (facts.window.isKnown() and cols > 0 and rows > 0) {
        return .{ .width_px = facts.window.width_px / cols, .height_px = facts.window.height_px / rows };
    }
    return .{ .width_px = 0, .height_px = 0 };
}

/// Final protocol once the cell size is known: SIXEL without a trusted
/// cell size would draw outside the rows reserved for the image.
pub fn finalize(protocol: Protocol, cell: CellSize) Protocol {
    if (protocol.requiresExactCellSize() and !cell.isKnown()) return .blocks;
    return protocol;
}

test "explicit override wins, including off" {
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .sixel }, decideFromEnvironment(.{ .handwork_images = "SIXEL", .term = "xterm-kitty" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .none }, decideFromEnvironment(.{ .handwork_images = "off" }));
    // An unknown override value is ignored rather than guessed at.
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .kitty }, decideFromEnvironment(.{ .handwork_images = "maybe", .term = "xterm-kitty" }));
}

test "known terminals are recognized from their environment" {
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .kitty }, decideFromEnvironment(.{ .term_program = "ghostty" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .kitty }, decideFromEnvironment(.{ .kitty_window_id = "1" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .iterm2 }, decideFromEnvironment(.{ .term_program = "iTerm.app" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .iterm2 }, decideFromEnvironment(.{ .term_program = "WezTerm" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .blocks }, decideFromEnvironment(.{ .term_program = "Apple_Terminal" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .blocks }, decideFromEnvironment(.{ .term = "xterm-kitty", .tmux = "/tmp/tmux" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .blocks }, decideFromEnvironment(.{ .is_windows = true }));
    try std.testing.expectEqual(EnvironmentDecision{ .probe = .{ .fallback = .blocks } }, decideFromEnvironment(.{ .is_windows = true, .wt_session = "x" }));
}

test "VS Code probes on Windows and overrides inherited terminal identities" {
    const expected = EnvironmentDecision{ .probe = .{ .fallback = .blocks } };
    try std.testing.expectEqual(expected, decideFromEnvironment(.{ .term_program = "vscode", .is_windows = true }));
    try std.testing.expectEqual(expected, decideFromEnvironment(.{ .term_program = "vscode", .kitty_window_id = "1", .term = "xterm-kitty" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .blocks }, decideFromEnvironment(.{ .term_program = "vscode", .tmux = "/tmp/tmux" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .blocks }, decideFromEnvironment(.{ .term_program = "vscode", .term = "screen-256color" }));
    try std.testing.expectEqual(EnvironmentDecision{ .decided = .none }, decideFromEnvironment(.{ .term_program = "vscode", .handwork_images = "off" }));
}

test "probe replies are parsed in any order alongside unrelated bytes" {
    const replies = "junk\x1b[6;20;10t\x1b_Gi=31;OK\x1b\\\x1b[4;800;1000t\x1b[?62;4;22c";
    const facts = parseProbeReplies(replies);
    try std.testing.expect(facts.kitty_graphics);
    try std.testing.expect(facts.sixel);
    try std.testing.expect(facts.device_attributes_seen);
    try std.testing.expectEqual(CellSize{ .width_px = 10, .height_px = 20 }, facts.cell);
    try std.testing.expectEqual(CellSize{ .width_px = 1000, .height_px = 800 }, facts.window);

    const plain = parseProbeReplies("\x1b_Gi=31;ENOTSUPPORTED:x\x1b\\\x1b[?1;2c");
    try std.testing.expect(!plain.kitty_graphics);
    try std.testing.expect(!plain.sixel);
}

test "probe choice prefers kitty, then sixel, and distrusts Konsole's kitty reply" {
    const both = ProbeFacts{ .kitty_graphics = true, .sixel = true };
    try std.testing.expectEqual(Protocol.kitty, chooseFromProbe(.{}, both, .blocks));
    try std.testing.expectEqual(Protocol.sixel, chooseFromProbe(.{ .konsole_version = "230800" }, both, .blocks));
    try std.testing.expectEqual(Protocol.blocks, chooseFromProbe(.{}, .{}, .blocks));
    try std.testing.expectEqual(Protocol.sixel, chooseFromProbe(.{ .term_program = "vscode" }, both, .blocks));
    try std.testing.expectEqual(Protocol.blocks, chooseFromProbe(.{ .term_program = "vscode" }, .{ .kitty_graphics = true }, .blocks));
}

test "XTSMGRAPHICS detects image add-ons without DA1 sixel attributes" {
    const replies = "\x1b[?1;2c\x1b[?2;0;756;742S\x1b[6;14;7t";
    const facts = parseProbeReplies(replies);
    try std.testing.expect(facts.sixel);
    try std.testing.expectEqual(CellSize{ .width_px = 7, .height_px = 14 }, facts.cell);
    // Graphics geometry is a canvas limit, not the terminal's window size.
    try std.testing.expect(!facts.window.isKnown());
    for ([_][]const u8{ "\x1b[?2;1;756;742S", "\x1b[?2;0;0;742S", "\x1b[?2;0;756;0S", "\x1b[?1;0;256S", "\x1b[?2;0;756;742" }) |invalid|
        try std.testing.expect(!parseProbeReplies(invalid).sixel);
}

test "VS Code probing waits past early DA1 until graphics and geometry arrive" {
    const env = Environment{ .term_program = "vscode" };
    const early = "\x1b[?1;2c";
    try std.testing.expect(!probeComplete(env, parseProbeReplies(early), true));
    const graphics = early ++ "\x1b_Gi=31;OK\x1b\\\x1b[?2;0;756;742S";
    try std.testing.expect(!probeComplete(env, parseProbeReplies(graphics), false));
    try std.testing.expect(probeComplete(env, parseProbeReplies(graphics), true));
    const complete = graphics ++ "\x1b[6;14;7t\x1b[?62;4;9;22c";
    try std.testing.expect(probeComplete(env, parseProbeReplies(complete), false));
    try std.testing.expectEqual(Protocol.sixel, chooseFromProbe(env, parseProbeReplies(complete), .blocks));
}

test "cell size resolution and the sixel safety fallback" {
    const none: CellSize = .{ .width_px = 0, .height_px = 0 };
    try std.testing.expectEqual(CellSize{ .width_px = 10, .height_px = 20 }, resolveCellSize(.{ .width_px = 800, .height_px = 480 }, 80, 24, .{}));
    try std.testing.expectEqual(CellSize{ .width_px = 9, .height_px = 19 }, resolveCellSize(none, 80, 24, .{ .cell = .{ .width_px = 9, .height_px = 19 } }));
    try std.testing.expectEqual(CellSize{ .width_px = 12, .height_px = 25 }, resolveCellSize(none, 80, 24, .{ .window = .{ .width_px = 960, .height_px = 600 } }));
    try std.testing.expectEqual(Protocol.blocks, finalize(.sixel, none));
    try std.testing.expectEqual(Protocol.kitty, finalize(.kitty, none));
}
