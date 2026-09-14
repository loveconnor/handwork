const std = @import("std");
const types = @import("../shared/types.zig");
const notice_layout = @import("../shared/notice_layout.zig");

const bar_width: usize = 24;

/// Display existing counters only. Never rebuild prompts, copy history, persist
/// settings, or trigger compaction just to inspect context.
pub fn show(app: anytype, context_window: ?u32) !void {
    const snapshot = app.session.usage.liveContextSnapshot();
    const used: ?u64 = if (snapshot) |value| value.used else null;
    const window: ?u64 = if (context_window) |value| value else null;

    var tree = notice_layout.Tree.init(app.alloc);
    defer tree.deinit();

    var used_buf: [32]u8 = undefined;
    var window_buf: [32]u8 = undefined;
    var free_buf: [32]u8 = undefined;
    var bar_buf: [bar_width * 3]u8 = undefined;

    if (used) |used_tokens| {
        const used_text = notice_layout.formatThousands(&used_buf, used_tokens);
        if (window) |window_tokens| {
            const percent = notice_layout.percentOf(used_tokens, window_tokens);
            try tree.setSummary("{s} of {s} tokens · {d}% used", .{
                used_text,
                notice_layout.formatThousands(&window_buf, window_tokens),
                percent,
            });
            const bar = notice_layout.formatBar(&bar_buf, used_tokens, window_tokens, bar_width);
            if (used_tokens <= window_tokens) {
                try tree.note("{s}  {s} tokens free", .{
                    bar,
                    notice_layout.formatThousands(&free_buf, window_tokens - used_tokens),
                });
            } else {
                try tree.note("{s}  {s} tokens over the window", .{
                    bar,
                    notice_layout.formatThousands(&free_buf, used_tokens - window_tokens),
                });
            }
        } else {
            try tree.setSummary("{s} tokens in the last provider report · window unknown", .{used_text});
        }
    } else if (window) |window_tokens| {
        try tree.setSummary("No provider report yet · {s} token window", .{
            notice_layout.formatThousands(&window_buf, window_tokens),
        });
    } else {
        try tree.setSummary("No provider report yet · window unknown", .{});
    }

    if (used) |used_tokens| {
        try tree.row("Last reported", "{s} tokens", .{notice_layout.formatThousands(&used_buf, used_tokens)});
    } else {
        try tree.rowText("Last reported", "not reported");
    }
    if (window) |window_tokens| {
        try tree.row("Model window", "{s} tokens", .{notice_layout.formatThousands(&window_buf, window_tokens)});
    } else {
        try tree.rowText("Model window", "unknown");
    }
    try tree.row("History turns", "{d}", .{app.session.historyLen()});
    try tree.note("The last provider report is not a next-prompt estimate; model changes or compaction since then are not reflected.", .{});

    const body = try tree.render();
    defer app.alloc.free(body);
    try app.writeDomainNotice(.{ .topic = "context", .tone = .information, .body = body }, true);
}

test "context command reads counters without changing session memory" {
    const Usage = @import("session_usage.zig").Usage;
    const App = struct {
        alloc: std.mem.Allocator = std.testing.allocator,
        session: struct {
            usage: Usage = Usage.initFresh(),
            turns: usize = 7,

            pub fn historyLen(self: *const @This()) usize {
                return self.turns;
            }
        } = .{},
        notice: [1024]u8 = undefined,
        notice_len: usize = 0,

        pub fn writeDomainNotice(self: *@This(), notice: types.SemanticNotice, _: bool) !void {
            try std.testing.expectEqualStrings("context", notice.topic);
            @memcpy(self.notice[0..notice.body.len], notice.body);
            self.notice_len = notice.body.len;
        }
    };
    var app: App = .{};
    defer app.session.usage.deinit(std.testing.allocator);
    try show(&app, null);
    try std.testing.expect(std.mem.find(u8, app.notice[0..app.notice_len], "not reported") != null);
    try std.testing.expect(std.mem.find(u8, app.notice[0..app.notice_len], "unknown") != null);
    try std.testing.expect(std.mem.find(u8, app.notice[0..app.notice_len], "├ History turns  7") != null);
    app.session.usage.latest_context_used = 43_000;
    try show(&app, 200_000);
    const body = app.notice[0..app.notice_len];
    try std.testing.expect(std.mem.startsWith(u8, body, "43,000 of 200,000 tokens · 22% used\n├ "));
    try std.testing.expect(std.mem.find(u8, body, "157,000 tokens free") != null);
    try std.testing.expect(std.mem.find(u8, body, "├ Last reported  43,000 tokens") != null);
    try std.testing.expect(std.mem.find(u8, body, "├ Model window   200,000 tokens") != null);
    try std.testing.expect(std.mem.find(u8, body, "\n└ The last provider report") != null);
    try std.testing.expectEqual(@as(usize, 7), app.session.turns);
    try std.testing.expectEqual(@as(?u64, 43_000), app.session.usage.latest_context_used);
    try std.testing.expectEqual(@as(u64, 1), app.session.usage.next_sequence);
    try std.testing.expect(!app.session.usage.dirty);
}
