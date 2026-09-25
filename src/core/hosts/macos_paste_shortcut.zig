const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");

const combined_session_state: u32 = 0;
const scroll_wheel_event: u32 = 22;

extern "c" fn CGEventSourceCounterForEventType(state_id: u32, event_type: u32) u32;
extern "c" fn handwork_cmd_v_monitor_create(status: *c_int) ?*anyopaque;
extern "c" fn handwork_cmd_v_monitor_poll(handle: *anyopaque) bool;
extern "c" fn handwork_cmd_v_monitor_destroy(handle: *anyopaque) void;
extern "c" fn ttyname(fd: c_int) ?[*:0]const u8;

pub const StartResult = enum { disabled, ready, permission_needed, unavailable };
pub const TabMatch = enum { yes, no, failed };

pub const Monitor = struct {
    started: bool = false,
    handle: ?*anyopaque = null,
    scroll_counter: ?u32 = null,

    pub fn start(self: *Monitor) StartResult {
        if (self.started) return if (self.handle != null) .ready else .disabled;
        self.started = true;
        if (comptime builtin.os.tag != .macos) return .disabled;
        const value = io_mod.getenv("HANDWORK_MACOS_CMD_V_MONITOR") orelse return .disabled;
        if (!monitorEnabled(value)) return .disabled;

        var status: c_int = 0;
        self.handle = handwork_cmd_v_monitor_create(&status);
        return switch (status) {
            1 => .ready,
            2 => .permission_needed,
            else => .unavailable,
        };
    }

    pub fn poll(self: *Monitor) bool {
        if (comptime builtin.os.tag != .macos) return false;
        const handle = self.handle orelse return false;
        return handwork_cmd_v_monitor_poll(handle);
    }

    pub fn matchesFocusedTerminalTab(alloc: std.mem.Allocator) TabMatch {
        if (comptime builtin.os.tag != .macos) return .no;
        const current_tty = std.mem.span(ttyname(0) orelse return .failed);
        const script = [_][]const u8{
            "osascript",
            "-e",
            "tell application \"Terminal\"",
            "-e",
            "if not frontmost then return \"\"",
            "-e",
            "if (count of windows) is 0 then return \"\"",
            "-e",
            "return tty of selected tab of front window",
            "-e",
            "end tell",
        };
        const result = std.process.run(alloc, io_mod.getIo(), .{
            .argv = &script,
            .stdout_limit = .limited(1024),
            .stderr_limit = .limited(1024),
        }) catch return .failed;
        defer alloc.free(result.stdout);
        defer alloc.free(result.stderr);
        switch (result.term) {
            .exited => |code| if (code != 0) return .failed,
            else => return .failed,
        }
        return if (tabTtyMatches(current_tty, result.stdout)) .yes else .no;
    }

    pub fn deinit(self: *Monitor) void {
        if (comptime builtin.os.tag != .macos) return;
        if (self.handle) |handle| handwork_cmd_v_monitor_destroy(handle);
        self.* = .{};
    }

    /// Apple Terminal can scroll its own alternate-screen viewport even when
    /// the application has enabled mouse reporting. Observe the host event
    /// counter so the app can restore its live viewport when that happens.
    pub fn pollScroll(self: *Monitor) bool {
        if (comptime builtin.os.tag != .macos) return false;
        return self.updateScroll(CGEventSourceCounterForEventType(
            combined_session_state,
            scroll_wheel_event,
        ));
    }

    fn updateScroll(self: *Monitor, counter: u32) bool {
        const previous = self.scroll_counter orelse {
            self.scroll_counter = counter;
            return false;
        };
        self.scroll_counter = counter;
        return counter != previous;
    }
};

fn monitorEnabled(value: []const u8) bool {
    return std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true");
}

fn tabTtyMatches(current_tty: []const u8, reported_tty: []const u8) bool {
    return std.mem.eql(u8, current_tty, std.mem.trim(u8, reported_tty, " \t\r\n"));
}

test "Command-V monitor requires explicit opt-in" {
    try std.testing.expect(monitorEnabled("1"));
    try std.testing.expect(monitorEnabled("TRUE"));
    try std.testing.expect(!monitorEnabled("0"));
    try std.testing.expect(!monitorEnabled(""));
}

test "Command-V monitor matches only the current Terminal tab" {
    try std.testing.expect(tabTtyMatches("/dev/ttys001", "/dev/ttys001\n"));
    try std.testing.expect(!tabTtyMatches("/dev/ttys001", "/dev/ttys002\n"));
    try std.testing.expect(!tabTtyMatches("/dev/ttys001", ""));
}

test "scroll monitor establishes a baseline then reports counter changes" {
    var monitor = Monitor{};
    try std.testing.expect(!monitor.updateScroll(41));
    try std.testing.expect(!monitor.updateScroll(41));
    try std.testing.expect(monitor.updateScroll(42));
    try std.testing.expect(!monitor.updateScroll(42));
    try std.testing.expect(monitor.updateScroll(0));
}
