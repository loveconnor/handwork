//! Bridge the C entry point to Zig's platform-specific process metadata.
const std = @import("std");
const builtin = @import("builtin");

pub fn args(raw_args: []const [*:0]const u8) std.process.Args {
    if (comptime builtin.os.tag == .windows) {
        // The narrow C argv loses characters outside the active Windows code
        // page. Zig parses the original WTF-16 command line into WTF-8 instead.
        return .{ .vector = std.os.windows.peb().ProcessParameters.CommandLine.slice() };
    }
    return .{ .vector = raw_args };
}

pub fn environ(raw_env: [*:null]const ?[*:0]const u8) std.process.Environ.Block {
    if (comptime builtin.os.tag == .windows) return .global;
    var count: usize = 0;
    while (raw_env[count] != null) : (count += 1) {}
    return .{ .slice = raw_env[0..count :null] };
}

pub fn normalizeWindowsHome(map: *std.process.Environ.Map) !void {
    if (map.get("HOME") != null) return;
    if (map.get("USERPROFILE")) |profile| try map.put("HOME", profile);
}

test "Windows home uses USERPROFILE while preserving an explicit HOME" {
    var map = std.process.Environ.Map.init(std.testing.allocator);
    defer map.deinit();
    try map.put("USERPROFILE", "C:\\Users\\Renée");
    try normalizeWindowsHome(&map);
    try std.testing.expectEqualStrings("C:\\Users\\Renée", map.get("HOME").?);
    try map.put("HOME", "D:\\custom profile");
    try normalizeWindowsHome(&map);
    try std.testing.expectEqualStrings("D:\\custom profile", map.get("HOME").?);
}

test "POSIX startup preserves argument and environment vectors" {
    if (comptime builtin.os.tag == .windows) return error.SkipZigTest;
    const raw_args = [_][*:0]const u8{ "handwork", "ask", "two words" };
    const raw_env = [_:null]?[*:0]const u8{ "HOME=/home/tester", "EMPTY=" };
    const actual_args = args(&raw_args);
    try std.testing.expectEqualSlices([*:0]const u8, &raw_args, actual_args.vector);
    const actual_env = environ(&raw_env);
    try std.testing.expectEqualSlices(?[*:0]const u8, &raw_env, actual_env.slice);
}

test "Windows argument parsing preserves quoted Unicode paths and empty arguments" {
    const command_line = std.unicode.utf8ToUtf16LeStringLiteral(
        "handwork.exe ask \"C:\\Users\\Renée\\my project\" \"\" \"日本語 🧰\"",
    );
    var iterator = try std.process.Args.Iterator.Windows.init(std.testing.allocator, command_line);
    defer iterator.deinit();
    for ([_][]const u8{ "handwork.exe", "ask", "C:\\Users\\Renée\\my project", "", "日本語 🧰" }) |expected| {
        try std.testing.expectEqualStrings(expected, iterator.next().?);
    }
    try std.testing.expect(iterator.next() == null);
}

test "Windows startup uses the OS command line and global environment" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const raw_env = [_:null]?[*:0]const u8{};
    try std.testing.expect(!environ(&raw_env).isEmpty());
    try std.testing.expectEqualSlices(u16, std.os.windows.peb().ProcessParameters.CommandLine.slice(), args(&.{}).vector);
}
