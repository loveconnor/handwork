//! Windows console setup for the existing UTF-8 / VT terminal renderer.
const std = @import("std");
const builtin = @import("builtin");
const win = if (builtin.os.tag == .windows) @cImport({
    // Import API declarations only: Zig 0.16 cannot translate MinGW's
    // fortified wide-string inline wrappers in ReleaseSafe mode.
    @cDefine("_FORTIFY_SOURCE", "0");
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    @cInclude("windows.h");
}) else struct {};

const Handle = std.os.windows.HANDLE;
const utf8_code_page = 65001;

pub const Dimensions = struct { rows: u16, cols: u16 };

// SetConsoleMode flags are kept here so the mode policy is testable on every
// host. Windows API calls remain confined to this module.
const processed_input: u32 = 0x0001;
const line_input: u32 = 0x0002;
const echo_input: u32 = 0x0004;
const window_input: u32 = 0x0008;
const mouse_input: u32 = 0x0010;
const quick_edit: u32 = 0x0040;
const extended_flags: u32 = 0x0080;
const vt_input: u32 = 0x0200;
const processed_output: u32 = 0x0001;
const wrap_output: u32 = 0x0002;
const vt_output: u32 = 0x0004;

fn rawInputMode(original: u32) u32 {
    return (original & ~(processed_input | line_input | echo_input | window_input | mouse_input | quick_edit)) |
        extended_flags | vt_input;
}

fn vtOutputMode(original: u32) u32 {
    return original | processed_output | wrap_output | vt_output;
}

pub fn isTerminal(handle: Handle) bool {
    var mode: u32 = undefined;
    return win.GetConsoleMode(handle, &mode) != 0;
}

pub fn dimensions(output: Handle) !Dimensions {
    var info: win.CONSOLE_SCREEN_BUFFER_INFO = undefined;
    if (win.GetConsoleScreenBufferInfo(output, &info) == 0) return error.UnableToReadTerminalSize;
    // The screen buffer may be much taller than the visible viewport.
    return viewportDimensions(info.srWindow.Left, info.srWindow.Top, info.srWindow.Right, info.srWindow.Bottom);
}

pub fn read(input: Handle, out: []u8) !usize {
    if (out.len == 0) return 0;
    var count: u32 = 0;
    const capacity: u32 = @intCast(@min(out.len, std.math.maxInt(u32)));
    if (win.ReadFile(input, out.ptr, capacity, &count, null) == 0) return error.ConsoleInputFailed;
    return count;
}

/// Interactive reads stay in the console's event mode. Mixing ReadFile with
/// PeekConsoleInputW switches Windows' read mode and discards cached text,
/// including partial UTF-8 characters and terminal responses.
pub const InputReader = struct {
    high_surrogate: ?u16 = null,
    bytes: [4]u8 = undefined,
    len: u3 = 0,
    offset: u3 = 0,
    repeats: u16 = 0,

    pub fn poll(self: *InputReader, input: Handle, timeout_ms: i32) !bool {
        if (self.repeats > 0) return true;
        const started = win.GetTickCount64();
        while (true) {
            const remaining = remainingTimeout(started, win.GetTickCount64(), timeout_ms) orelse 0;
            if (!try pollInput(input, if (timeout_ms < 0) -1 else @intCast(remaining))) return false;
            var record: win.INPUT_RECORD = undefined;
            var count: u32 = 0;
            if (win.ReadConsoleInputW(input, &record, 1, &count) == 0) return error.ConsoleInputFailed;
            if (count != 0 and record.EventType == win.KEY_EVENT and record.Event.KeyEvent.bKeyDown != 0) {
                const key = record.Event.KeyEvent;
                // With VT input enabled, navigation and function keys arrive as
                // synthesized Unicode records containing their escape sequence.
                if (inputCodeUnit(key.wVirtualKeyCode, key.dwControlKeyState, key.uChar.UnicodeChar)) |unit| {
                    self.pushCodeUnit(unit, key.wRepeatCount);
                    if (self.repeats > 0) return true;
                }
            }
            if (remainingTimeout(started, win.GetTickCount64(), timeout_ms) == null) return false;
        }
    }

    pub fn read(self: *InputReader, input: Handle, out: []u8) !usize {
        if (out.len == 0) return 0;
        _ = try self.poll(input, -1);
        var written: usize = 0;
        while (true) {
            written += self.readPending(out[written..]);
            if (written == out.len or !try self.poll(input, 0)) return written;
        }
    }

    fn pushCodeUnit(self: *InputReader, unit: u16, repeats: u16) void {
        std.debug.assert(self.repeats == 0);
        if (unit >= 0xd800 and unit <= 0xdbff) {
            self.high_surrogate = unit;
            return;
        }
        const scalar: u21 = if (unit >= 0xdc00 and unit <= 0xdfff) blk: {
            const high = self.high_surrogate orelse break :blk 0xfffd;
            break :blk 0x10000 + (@as(u21, high - 0xd800) << 10) + (unit - 0xdc00);
        } else unit;
        self.high_surrogate = null;
        self.len = std.unicode.utf8Encode(scalar, &self.bytes) catch unreachable;
        self.offset = 0;
        self.repeats = @max(1, repeats);
    }

    fn readPending(self: *InputReader, out: []u8) usize {
        var written: usize = 0;
        while (self.repeats > 0 and written < out.len) {
            const n = @min(out.len - written, self.len - self.offset);
            @memcpy(out[written..][0..n], self.bytes[self.offset..][0..n]);
            written += n;
            self.offset += @intCast(n);
            if (self.offset == self.len) {
                self.offset = 0;
                self.repeats -= 1;
            }
        }
        return written;
    }
};

fn inputCodeUnit(key: u16, modifiers: u32, unit: u16) ?u16 {
    if (unit != 0) return unit;
    if (isControlSpace(key, modifiers)) return 0;
    // Some console hosts report the virtual shortcut without a Unicode unit.
    // Preserve Ctrl-V on the same raw-byte route as terminal keyboard reports.
    if (key == 'V' and (modifiers & 0x000c) != 0 and (modifiers & 0x0003) == 0) return 22;
    return null;
}

test "Windows console forwards Ctrl V without a Unicode unit and preserves text paste" {
    try std.testing.expectEqual(@as(?u16, 22), inputCodeUnit('V', 0x0008, 0));
    try std.testing.expectEqual(@as(?u16, 22), inputCodeUnit('V', 0x0004, 0));
    try std.testing.expectEqual(@as(?u16, 22), inputCodeUnit('V', 0x0008, 22));
    try std.testing.expectEqual(@as(?u16, null), inputCodeUnit('V', 0, 0));
    try std.testing.expectEqual(@as(?u16, null), inputCodeUnit('V', 0x000a, 0));
    try std.testing.expectEqual(@as(?u16, 'v'), inputCodeUnit('V', 0, 'v'));
    try std.testing.expectEqual(@as(?u16, '['), inputCodeUnit(0, 0, '['));
    try std.testing.expectEqual(@as(?u16, 0), inputCodeUnit(' ', 0x0008, 0));
}

fn isControlSpace(key: u16, modifiers: u32) bool {
    return key == 0x20 and (modifiers & 0x000c) != 0;
}

/// Nonblocking input for an authentication line. Reading console events avoids
/// a cooked ReadFile call blocking the OAuth cancellation loop until Enter.
pub fn pollLineBytes(input: Handle, out: []u8, high_surrogate: *?u16) !?usize {
    std.debug.assert(out.len >= 4);
    if (!isTerminal(input)) {
        if (win.GetFileType(input) == win.FILE_TYPE_PIPE) {
            var available: u32 = 0;
            if (win.PeekNamedPipe(input, null, 0, null, &available, null) == 0) {
                if (win.GetLastError() == win.ERROR_BROKEN_PIPE) return 0;
                return error.ConsoleInputFailed;
            }
            if (available == 0) return null;
        }
        return try read(input, out);
    }
    while (try pollInput(input, 0)) {
        var record: win.INPUT_RECORD = undefined;
        var count: u32 = 0;
        if (win.ReadConsoleInputW(input, &record, 1, &count) == 0) return error.ConsoleInputFailed;
        if (count == 0) return null;
        const unit = record.Event.KeyEvent.uChar.UnicodeChar;
        if (unit == 0) continue;
        if (unit == 3) return error.Cancelled;
        if (unit >= 0xd800 and unit <= 0xdbff) {
            high_surrogate.* = unit;
            continue;
        }
        const codepoint: u21 = if (unit >= 0xdc00 and unit <= 0xdfff) blk: {
            const high = high_surrogate.* orelse return error.InvalidUtf16;
            break :blk 0x10000 + (@as(u21, high - 0xd800) << 10) + (unit - 0xdc00);
        } else if (unit == '\r') '\n' else unit;
        high_surrogate.* = null;
        return try std.unicode.utf8Encode(codepoint, out[0..4]);
    }
    return null;
}

fn viewportDimensions(left: i16, top: i16, right: i16, bottom: i16) !Dimensions {
    const cols = @as(i32, right) - @as(i32, left) + 1;
    const rows = @as(i32, bottom) - @as(i32, top) + 1;
    if (left < 0 or top < 0 or cols <= 0 or rows <= 0) return error.UnableToReadTerminalSize;
    return .{ .rows = @intCast(rows), .cols = @intCast(cols) };
}

pub const State = struct {
    input: Handle,
    output: Handle,
    input_mode: u32,
    output_mode: u32,
    input_code_page: u32,
    output_code_page: u32,
    active: bool = false,

    pub fn capture(input: Handle, output: Handle) !State {
        var state: State = .{
            .input = input,
            .output = output,
            .input_mode = undefined,
            .output_mode = undefined,
            .input_code_page = win.GetConsoleCP(),
            .output_code_page = win.GetConsoleOutputCP(),
        };
        if (win.GetConsoleMode(input, &state.input_mode) == 0 or
            win.GetConsoleMode(output, &state.output_mode) == 0) return error.NotATerminal;
        if (state.input_code_page == 0 or state.output_code_page == 0) return error.ConsoleCodePageFailed;
        return state;
    }

    pub fn enable(self: *State) !void {
        if (self.active) return;
        if (win.SetConsoleMode(self.output, vtOutputMode(self.output_mode)) == 0) return error.ConsoleModeFailed;
        errdefer _ = win.SetConsoleMode(self.output, self.output_mode);
        if (win.SetConsoleMode(self.input, rawInputMode(self.input_mode)) == 0) return error.ConsoleModeFailed;
        errdefer _ = win.SetConsoleMode(self.input, self.input_mode);
        if (win.SetConsoleCP(utf8_code_page) == 0) return error.ConsoleCodePageFailed;
        errdefer _ = win.SetConsoleCP(self.input_code_page);
        if (win.SetConsoleOutputCP(utf8_code_page) == 0) return error.ConsoleCodePageFailed;
        self.active = true;
    }

    pub fn restore(self: *State) !void {
        if (!self.active) return;
        // Attempt every restoration even if one handle has already closed.
        const input_ok = win.SetConsoleMode(self.input, self.input_mode) != 0;
        const output_ok = win.SetConsoleMode(self.output, self.output_mode) != 0;
        const input_cp_ok = win.SetConsoleCP(self.input_code_page) != 0;
        const output_cp_ok = win.SetConsoleOutputCP(self.output_code_page) != 0;
        if (!input_ok or !output_ok or !input_cp_ok or !output_cp_ok) return error.ConsoleRestoreFailed;
        self.active = false;
    }
};

/// Wait for stream-readable keyboard input. Console handles are also signaled
/// for focus, mouse, resize and key-up records; remove those rather than let a
/// subsequent stream read block on them. Layout is polled by resize_runtime.
pub fn pollInput(input: Handle, timeout_ms: i32) !bool {
    const started = win.GetTickCount64();
    while (true) {
        var record: win.INPUT_RECORD = undefined;
        var count: u32 = 0;
        if (win.PeekConsoleInputW(input, &record, 1, &count) == 0) return error.ConsoleInputFailed;
        if (count != 0) {
            if (record.EventType == win.KEY_EVENT and record.Event.KeyEvent.bKeyDown != 0) {
                const key = record.Event.KeyEvent;
                if (key.uChar.UnicodeChar != 0 or streamKey(key.wVirtualKeyCode) or isControlSpace(key.wVirtualKeyCode, key.dwControlKeyState)) return true;
            }
            if (win.ReadConsoleInputW(input, &record, 1, &count) == 0) return error.ConsoleInputFailed;
        }
        const remaining = remainingTimeout(started, win.GetTickCount64(), timeout_ms) orelse return false;
        // Check the deadline after discarded events too, so repeated focus or
        // key-up events cannot starve the application loop.
        switch (win.WaitForSingleObject(input, remaining)) {
            win.WAIT_OBJECT_0 => {},
            win.WAIT_TIMEOUT => return false,
            else => return error.ConsoleInputFailed,
        }
    }
}

/// Authentication waits for Enter in cooked mode. A stream read after polling
/// any key could block until a whole line arrives, preventing cancellation.
pub fn waitForEnter(input: Handle, timeout_ms: u64) !bool {
    const bounded: i32 = @intCast(@min(timeout_ms, std.math.maxInt(i32)));
    const started = win.GetTickCount64();
    while (true) {
        const remaining = remainingTimeout(started, win.GetTickCount64(), bounded) orelse 0;
        if (!try pollInput(input, @intCast(remaining))) return false;
        var record: win.INPUT_RECORD = undefined;
        var count: u32 = 0;
        if (win.ReadConsoleInputW(input, &record, 1, &count) == 0) return error.ConsoleInputFailed;
        if (count != 0 and record.EventType == win.KEY_EVENT and record.Event.KeyEvent.bKeyDown != 0) {
            const char = record.Event.KeyEvent.uChar.UnicodeChar;
            if (char == '\r' or char == '\n') return true;
        }
        if (remainingTimeout(started, win.GetTickCount64(), bounded) == null) return false;
    }
}

fn remainingTimeout(started: u64, now: u64, timeout_ms: i32) ?u32 {
    if (timeout_ms < 0) return std.math.maxInt(u32);
    const duration: u64 = @intCast(timeout_ms);
    const elapsed = now -| started;
    if (elapsed >= duration) return null;
    return @intCast(duration - elapsed);
}

fn streamKey(key: u16) bool {
    return switch (key) {
        0x08,
        0x09,
        0x0d,
        0x1b, // Backspace, Tab, Enter, Escape.
        0x21...0x28, // Page Up/Down, End, Home and arrows.
        0x2d,
        0x2e, // Insert, Delete.
        0x70...0x7b, // F1–F12, translated by the console's VT input mode.
        => true,
        else => false,
    };
}

test "raw Windows input delivers control keys and VT sequences without Quick Edit pauses" {
    const original = processed_input | line_input | echo_input | window_input | mouse_input | quick_edit | 0x1000;
    const raw = rawInputMode(original);
    try std.testing.expectEqual(@as(u32, 0), raw & (processed_input | line_input | echo_input | quick_edit | window_input | mouse_input));
    try std.testing.expectEqual(extended_flags | vt_input | 0x1000, raw);
    try std.testing.expectEqual(@as(u32, 0x1007), vtOutputMode(0x1000));
}

test "Windows dimensions use the visible window rather than scrollback" {
    try std.testing.expectEqual(Dimensions{ .rows = 24, .cols = 80 }, try viewportDimensions(0, 100, 79, 123));
    try std.testing.expectEqual(Dimensions{ .rows = 1, .cols = 1 }, try viewportDimensions(5, 7, 5, 7));
    try std.testing.expectError(error.UnableToReadTerminalSize, viewportDimensions(2, 0, 0, 23));
    try std.testing.expectError(error.UnableToReadTerminalSize, viewportDimensions(0, -1, 79, 23));
}

test "Windows input polling honors timeout and ignores modifier-only keys" {
    try std.testing.expectEqual(@as(?u32, 10), remainingTimeout(100, 110, 20));
    try std.testing.expectEqual(@as(?u32, null), remainingTimeout(100, 120, 20));
    try std.testing.expectEqual(@as(?u32, null), remainingTimeout(100, 100, 0));
    try std.testing.expectEqual(@as(?u32, std.math.maxInt(u32)), remainingTimeout(100, 120, -1));
    try std.testing.expect(streamKey(0x26));
    try std.testing.expect(!streamKey(0x10)); // Shift.
    try std.testing.expect(!streamKey(0x11)); // Control.
    try std.testing.expect(!streamKey(0x12)); // Alt.
}

test "Windows input preserves UTF-8 and repeats across one-byte reads" {
    var reader = InputReader{};
    var byte: [1]u8 = undefined;
    for ([_]struct { unit: u16, repeats: u16, expected: []const u8 }{
        .{ .unit = '日', .repeats = 2, .expected = "日日" },
        .{ .unit = 0xd83d, .repeats = 1, .expected = "" },
        .{ .unit = 0xde00, .repeats = 1, .expected = "😀" },
        .{ .unit = 3, .repeats = 1, .expected = "\x03" },
        .{ .unit = 0, .repeats = 1, .expected = "\x00" },
        .{ .unit = 'x', .repeats = 0, .expected = "x" },
    }) |case| {
        reader.pushCodeUnit(case.unit, case.repeats);
        for (case.expected) |expected| {
            try std.testing.expectEqual(@as(usize, 1), reader.readPending(&byte));
            try std.testing.expectEqual(expected, byte[0]);
        }
        try std.testing.expectEqual(@as(usize, 0), reader.readPending(&byte));
    }
}

test "Windows input preserves fragmented mouse and keyboard reports exactly" {
    const reports = "\x1b[<35;20;56M\x1b[<51;19;56M\x1b[A\x1b[200~hello\x1b[201~";
    var reader = InputReader{};
    var received: [reports.len]u8 = undefined;
    for (reports, 0..) |unit, i| {
        reader.pushCodeUnit(unit, 1);
        try std.testing.expectEqual(@as(usize, 1), reader.readPending(received[i..][0..1]));
    }
    try std.testing.expectEqualStrings(reports, &received);
}

test "Windows input recovers from unpaired UTF-16 without losing the next report" {
    var reader = InputReader{};
    var bytes: [4]u8 = undefined;
    reader.pushCodeUnit(0xd83d, 1);
    reader.pushCodeUnit(0x1b, 1);
    try std.testing.expectEqual(@as(usize, 1), reader.readPending(&bytes));
    try std.testing.expectEqual(@as(u8, 0x1b), bytes[0]);
    reader.pushCodeUnit(0xde00, 1);
    const n = reader.readPending(&bytes);
    try std.testing.expectEqualStrings("�", bytes[0..n]);
}

test "Windows console enables and restores modes and UTF-8 code pages" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const saved_stdin = win.GetStdHandle(win.STD_INPUT_HANDLE);
    const saved_stdout = win.GetStdHandle(win.STD_OUTPUT_HANDLE);
    const saved_stderr = win.GetStdHandle(win.STD_ERROR_HANDLE);
    const allocated = win.AllocConsole() != 0;
    defer if (allocated) {
        _ = win.FreeConsole();
        _ = win.SetStdHandle(win.STD_INPUT_HANDLE, saved_stdin);
        _ = win.SetStdHandle(win.STD_OUTPUT_HANDLE, saved_stdout);
        _ = win.SetStdHandle(win.STD_ERROR_HANDLE, saved_stderr);
    };
    if (allocated) {
        // AllocConsole may replace redirected standard handles. Keep the test
        // runner's IPC pipes intact while using dedicated console handles.
        if (win.SetStdHandle(win.STD_INPUT_HANDLE, saved_stdin) == 0 or
            win.SetStdHandle(win.STD_OUTPUT_HANDLE, saved_stdout) == 0 or
            win.SetStdHandle(win.STD_ERROR_HANDLE, saved_stderr) == 0) return error.ConsoleModeFailed;
    }
    // Open the console itself so this test also works when the test runner's
    // standard streams are redirected by CI.
    const input = win.CreateFileW(std.unicode.utf8ToUtf16LeStringLiteral("CONIN$"), win.GENERIC_READ | win.GENERIC_WRITE, win.FILE_SHARE_READ | win.FILE_SHARE_WRITE, null, win.OPEN_EXISTING, 0, null);
    if (input == win.INVALID_HANDLE_VALUE) return error.ConsoleInputFailed;
    defer _ = win.CloseHandle(input);
    const output = win.CreateFileW(std.unicode.utf8ToUtf16LeStringLiteral("CONOUT$"), win.GENERIC_READ | win.GENERIC_WRITE, win.FILE_SHARE_READ | win.FILE_SHARE_WRITE, null, win.OPEN_EXISTING, 0, null);
    if (output == win.INVALID_HANDLE_VALUE) return error.ConsoleOutputFailed;
    defer _ = win.CloseHandle(output);
    var state = try State.capture(input.?, output.?);
    try std.testing.expect(isTerminal(input.?));
    try std.testing.expect(isTerminal(output.?));
    // A failure after changing the output mode must restore that mode.
    var invalid_input = state;
    invalid_input.input = std.os.windows.INVALID_HANDLE_VALUE;
    try std.testing.expectError(error.ConsoleModeFailed, invalid_input.enable());
    const after_failure = try State.capture(input.?, output.?);
    try std.testing.expectEqual(state.output_mode, after_failure.output_mode);
    defer state.restore() catch {};
    try state.enable();
    try state.enable();
    const enabled = try State.capture(input.?, output.?);
    try std.testing.expectEqual(rawInputMode(state.input_mode), enabled.input_mode);
    try std.testing.expectEqual(vtOutputMode(state.output_mode), enabled.output_mode);
    try std.testing.expectEqual(@as(u32, utf8_code_page), enabled.input_code_page);
    try std.testing.expectEqual(@as(u32, utf8_code_page), enabled.output_code_page);
    _ = try dimensions(output.?);
    if (allocated) {
        // Only seed input when this process owns a newly allocated console.
        // Never discard or consume input from a user's existing terminal.
        try std.testing.expect(!try pollInput(input.?, 0));
        var events = [_]win.INPUT_RECORD{
            std.mem.zeroes(win.INPUT_RECORD),
            std.mem.zeroes(win.INPUT_RECORD),
            std.mem.zeroes(win.INPUT_RECORD),
        };
        events[0].EventType = win.KEY_EVENT;
        events[0].Event.KeyEvent.bKeyDown = 0;
        events[0].Event.KeyEvent.wVirtualKeyCode = 0x41;
        events[1].EventType = win.KEY_EVENT;
        events[1].Event.KeyEvent.bKeyDown = 1;
        events[1].Event.KeyEvent.wRepeatCount = 1;
        events[1].Event.KeyEvent.uChar.UnicodeChar = '日';
        events[2].EventType = win.KEY_EVENT;
        events[2].Event.KeyEvent.bKeyDown = 1;
        events[2].Event.KeyEvent.wRepeatCount = 1;
        events[2].Event.KeyEvent.uChar.UnicodeChar = 3;
        var written: u32 = 0;
        if (win.WriteConsoleInputW(input, &events, events.len, &written) == 0 or written != events.len) return error.ConsoleInputFailed;
        try std.testing.expect(try pollInput(input.?, 100));
        var reader = InputReader{};
        var bytes: [64]u8 = undefined;
        var count: usize = 0;
        while (count < "日\x03".len) {
            try std.testing.expect(try reader.poll(input.?, 100));
            // Poll between every byte, including inside a UTF-8 scalar.
            try std.testing.expect(try reader.poll(input.?, 0));
            const received = try reader.read(input.?, bytes[count..][0..1]);
            try std.testing.expect(received > 0);
            count += received;
        }
        try std.testing.expectEqualStrings("日\x03", bytes[0..count]);
        const reports = "\x1b[<35;20;56M\x1b[<51;19;56M\x1b[A\x1b[200~日😀\x1b[201~";
        const report_units = std.unicode.utf8ToUtf16LeStringLiteral(reports);
        var report_events: [report_units.len]win.INPUT_RECORD = undefined;
        for (&report_events, report_units) |*event, unit| {
            event.* = std.mem.zeroes(win.INPUT_RECORD);
            event.EventType = win.KEY_EVENT;
            event.Event.KeyEvent.bKeyDown = 1;
            event.Event.KeyEvent.wRepeatCount = 1;
            event.Event.KeyEvent.uChar.UnicodeChar = unit;
        }
        if (win.WriteConsoleInputW(input, &report_events, report_events.len, &written) == 0 or written != report_events.len) return error.ConsoleInputFailed;
        for (reports) |expected| {
            try std.testing.expect(try reader.poll(input.?, 100));
            try std.testing.expect(try reader.poll(input.?, 0));
            try std.testing.expectEqual(@as(usize, 1), try reader.read(input.?, bytes[0..1]));
            try std.testing.expectEqual(expected, bytes[0]);
        }
        try std.testing.expect(!try reader.poll(input.?, 0));
        events[0] = std.mem.zeroes(win.INPUT_RECORD);
        events[0].EventType = win.KEY_EVENT;
        events[0].Event.KeyEvent.bKeyDown = 1;
        events[0].Event.KeyEvent.wRepeatCount = 1;
        events[0].Event.KeyEvent.wVirtualKeyCode = win.VK_RETURN;
        events[0].Event.KeyEvent.uChar.UnicodeChar = '\r';
        if (win.WriteConsoleInputW(input, &events, 1, &written) == 0 or written != 1) return error.ConsoleInputFailed;
        try std.testing.expect(try waitForEnter(input.?, 100));
        try std.testing.expect(!try waitForEnter(input.?, 0));
        // Manual OAuth input must accept pasted UTF-16 surrogate pairs and
        // observe cancellation without waiting for a cooked line to finish.
        for (&events) |*event| {
            event.* = std.mem.zeroes(win.INPUT_RECORD);
            event.EventType = win.KEY_EVENT;
            event.Event.KeyEvent.bKeyDown = 1;
            event.Event.KeyEvent.wRepeatCount = 1;
        }
        events[0].Event.KeyEvent.uChar.UnicodeChar = 0xd83d;
        events[1].Event.KeyEvent.uChar.UnicodeChar = 0xde00;
        events[2].Event.KeyEvent.uChar.UnicodeChar = 3;
        if (win.WriteConsoleInputW(input, &events, events.len, &written) == 0 or written != events.len) return error.ConsoleInputFailed;
        var high_surrogate: ?u16 = null;
        const pasted = (try pollLineBytes(input.?, &bytes, &high_surrogate)).?;
        try std.testing.expectEqualStrings("😀", bytes[0..pasted]);
        try std.testing.expectEqual(@as(?u16, null), high_surrogate);
        try std.testing.expectError(error.Cancelled, pollLineBytes(input.?, &bytes, &high_surrogate));
        try std.testing.expectEqual(@as(?usize, null), try pollLineBytes(input.?, &bytes, &high_surrogate));
    }
    try state.restore();
    try state.restore();
    const restored = try State.capture(input.?, output.?);
    try std.testing.expectEqual(state.input_mode, restored.input_mode);
    try std.testing.expectEqual(state.output_mode, restored.output_mode);
    try std.testing.expectEqual(state.input_code_page, restored.input_code_page);
    try std.testing.expectEqual(state.output_code_page, restored.output_code_page);
    _ = try pollInput(input.?, 0);
    try std.testing.expectEqual(saved_stdin, win.GetStdHandle(win.STD_INPUT_HANDLE));
    try std.testing.expectEqual(saved_stdout, win.GetStdHandle(win.STD_OUTPUT_HANDLE));
    try std.testing.expectEqual(saved_stderr, win.GetStdHandle(win.STD_ERROR_HANDLE));
}
