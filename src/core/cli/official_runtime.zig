//! Launch installed official-runtime adapters without involving native model credentials.
const std = @import("std");
const io_mod = @import("../shared/io.zig");
pub fn run(alloc: std.mem.Allocator, executable: []const u8, args: []const [:0]const u8) !u8 {
    const directory = std.fs.path.dirname(executable) orelse return error.InvalidExecutablePath;
    const script = try std.fs.path.resolve(alloc, &.{ directory, "..", "lib", "handwork", "cli.mjs" });
    defer alloc.free(script);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(alloc);
    try argv.appendSlice(alloc, &.{ "node", script });
    for (args) |arg| try argv.append(alloc, arg);
    var child = try std.process.spawn(io_mod.getIo(), .{ .argv = argv.items, .stdin = .inherit, .stdout = .inherit, .stderr = .inherit });
    const result = try child.wait(io_mod.getIo());
    return switch (result) {
        .exited => |code| code,
        else => 1,
    };
}
