const builtin = @import("builtin");

const combined_session_state: u32 = 0;
const command_flag_mask: u64 = 1 << 20;
const v_keycode: u16 = 9;
const scroll_wheel_event: u32 = 22;

extern "c" fn CGEventSourceKeyState(state_id: u32, key: u16) bool;
extern "c" fn CGEventSourceFlagsState(state_id: u32) u64;
extern "c" fn CGEventSourceCounterForEventType(state_id: u32, event_type: u32) u32;

pub const Monitor = struct {
    down: bool = false,
    scroll_counter: ?u32 = null,

    pub fn poll(self: *Monitor) bool {
        if (comptime builtin.os.tag != .macos) return false;
        const pressed = CGEventSourceKeyState(combined_session_state, v_keycode) and
            (CGEventSourceFlagsState(combined_session_state) & command_flag_mask) != 0;
        return self.update(pressed);
    }

    fn update(self: *Monitor, pressed: bool) bool {
        const triggered = pressed and !self.down;
        self.down = pressed;
        return triggered;
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

test "paste shortcut monitor triggers once per key press" {
    var monitor = Monitor{};
    try @import("std").testing.expect(!monitor.update(false));
    try @import("std").testing.expect(monitor.update(true));
    try @import("std").testing.expect(!monitor.update(true));
    try @import("std").testing.expect(!monitor.update(false));
    try @import("std").testing.expect(monitor.update(true));
}

test "scroll monitor establishes a baseline then reports counter changes" {
    var monitor = Monitor{};
    try @import("std").testing.expect(!monitor.updateScroll(41));
    try @import("std").testing.expect(!monitor.updateScroll(41));
    try @import("std").testing.expect(monitor.updateScroll(42));
    try @import("std").testing.expect(!monitor.updateScroll(42));
    try @import("std").testing.expect(monitor.updateScroll(0));
}
