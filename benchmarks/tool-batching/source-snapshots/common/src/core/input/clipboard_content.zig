const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");

pub fn loadText(alloc: std.mem.Allocator, limit: usize) ![]u8 {
    if (builtin.os.tag != .macos) return error.Unsupported;
    const result = try std.process.run(alloc, io_mod.getIo(), .{
        .argv = &.{"pbpaste"},
        .stdout_limit = .limited(limit),
        .stderr_limit = .limited(4096),
    });
    defer alloc.free(result.stderr);
    errdefer alloc.free(result.stdout);
    switch (result.term) {
        .exited => |code| if (code == 0) return result.stdout,
        else => {},
    }
    return error.ClipboardReadFailed;
}
