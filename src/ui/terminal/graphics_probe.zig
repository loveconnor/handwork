//! Startup detection of inline image support for the interactive terminal.

const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../../core/shared/io.zig");
const debug_trace = @import("../../core/shared/debug_trace.zig");
const shell_runtime = @import("../shell_runtime.zig");
const detection = @import("graphics/detection.zig");
const inline_images = @import("../images/inline_images.zig");

/// Replies normally arrive within one round trip; the deadline only bounds
/// terminals that ignore DA1 entirely.
const probe_deadline_ms: i64 = 250;

pub fn detectCapabilities(
    terminal_state: *const shell_runtime.TerminalState,
    cols: u16,
    rows: u16,
    truecolor: bool,
) inline_images.Capabilities {
    if (comptime builtin.os.tag == .wasi) return .{};
    const env = detection.Environment{
        .handwork_images = io_mod.getenv("HANDWORK_IMAGES"),
        .term = io_mod.getenv("TERM"),
        .term_program = io_mod.getenv("TERM_PROGRAM"),
        .kitty_window_id = io_mod.getenv("KITTY_WINDOW_ID"),
        .wt_session = io_mod.getenv("WT_SESSION"),
        .tmux = io_mod.getenv("TMUX"),
        .konsole_version = io_mod.getenv("KONSOLE_VERSION"),
        .is_windows = builtin.os.tag == .windows,
    };
    const winsize_px = windowPixels();
    const decision = detection.decideFromEnvironment(env);

    var facts: detection.ProbeFacts = .{};
    const needs_probe = switch (decision) {
        .probe => true,
        // Known terminals still need a cell size when the kernel lacks one.
        .decided => |chosen| chosen != .none and chosen != .blocks and !winsize_px.isKnown(),
    };
    if (needs_probe) facts = probe(terminal_state);

    const chosen = switch (decision) {
        .decided => |forced| forced,
        .probe => |p| detection.chooseFromProbe(env, facts, p.fallback),
    };
    const cell = detection.resolveCellSize(winsize_px, cols, rows, facts);
    const protocol = detection.finalize(chosen, cell);
    debug_trace.logf(
        "images",
        "capabilities protocol={s} chosen={s} cell={d}x{d} probed={} kitty={} sixel={}",
        .{ @tagName(protocol), @tagName(chosen), cell.width_px, cell.height_px, needs_probe, facts.kitty_graphics, facts.sixel },
    );
    return .{
        .protocol = protocol,
        .cell = cell,
        .color_depth = if (truecolor) .truecolor else .indexed256,
    };
}

/// Re-reads the cell size after a resize. Keeps the previous value when
/// the kernel cannot report pixels, since probing mid-session would race
/// with user input.
pub fn refreshCellSize(previous: detection.CellSize, cols: u16, rows: u16) detection.CellSize {
    const winsize_px = windowPixels();
    const resolved = detection.resolveCellSize(winsize_px, cols, rows, .{});
    return if (resolved.isKnown()) resolved else previous;
}

fn windowPixels() detection.CellSize {
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .wasi) return .{ .width_px = 0, .height_px = 0 };
    var ws: std.posix.winsize = .{ .row = 0, .col = 0, .xpixel = 0, .ypixel = 0 };
    const req: c_int = @intCast(std.c.T.IOCGWINSZ);
    if (std.c.ioctl(std.posix.STDOUT_FILENO, req, &ws) == -1) return .{ .width_px = 0, .height_px = 0 };
    return .{ .width_px = ws.xpixel, .height_px = ws.ypixel };
}

fn probe(terminal_state: *const shell_runtime.TerminalState) detection.ProbeFacts {
    var stdout_file = std.Io.File.stdout();
    stdout_file.writeStreamingAll(io_mod.getIo(), detection.probe_query) catch return .{};

    var buf: [512]u8 = undefined;
    var len: usize = 0;
    const deadline_ms = io_mod.milliTimestamp() + probe_deadline_ms;
    while (len < buf.len) {
        const now_ms = io_mod.milliTimestamp();
        if (now_ms >= deadline_ms) break;
        const poll = terminal_state.pollInput(@intCast(deadline_ms - now_ms)) catch break;
        if (poll.closed() or !poll.readable) break;
        const n = terminal_state.read(buf[len..]) catch break;
        if (n == 0) break;
        len += n;
        if (detection.parseProbeReplies(buf[0..len]).device_attributes_seen) break;
    }
    return detection.parseProbeReplies(buf[0..len]);
}
