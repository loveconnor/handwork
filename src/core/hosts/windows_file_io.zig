//! Work around Zig 0.16's Windows no-follow file-open metadata mismatch.
const std = @import("std");
const builtin = @import("builtin");

var wrapped_vtable: std.Io.VTable = undefined;
var original_vtable: ?*const std.Io.VTable = null;

/// Install before starting threads, like the Darwin process-spawn adapter.
pub fn wrap(original: std.Io) std.Io {
    if (original_vtable) |vtable| {
        std.debug.assert(vtable == original.vtable);
    } else {
        wrapped_vtable = original.vtable.*;
        wrapped_vtable.dirOpenFile = openFile;
        original_vtable = original.vtable;
    }
    return .{ .userdata = original.userdata, .vtable = &wrapped_vtable };
}

fn openFile(userdata: ?*anyopaque, dir: std.Io.Dir, path: []const u8, options: std.Io.Dir.OpenFileOptions) std.Io.File.OpenError!std.Io.File {
    var file = try original_vtable.?.dirOpenFile(userdata, dir, path, options);
    // Threaded.dirOpenFileWtf16 uses ASYNCHRONOUS when follow_symlinks=false
    // but returns nonblocking=false. NtReadFile can then return PENDING into
    // the synchronous reader's unreachable branch. Match the actual handle
    // mode so reads and writes await completion through the async backend.
    if (!options.follow_symlinks) file.flags.nonblocking = true;
    return file;
}

test "Windows no-follow file handles read and write through the matching I/O mode" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const io = wrap(std.testing.io);
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "日本語.json", .data = "before" });
    const file = try tmp.dir.openFile(io, "日本語.json", .{ .mode = .read_write, .follow_symlinks = false });
    defer file.close(io);
    try file.writeStreamingAll(io, "after!");
    var buffer: [32]u8 = undefined;
    var reader = file.reader(io, &buffer);
    const bytes = try reader.interface.allocRemaining(std.testing.allocator, .limited(32));
    defer std.testing.allocator.free(bytes);
    try std.testing.expectEqualStrings("after!", bytes);
}
