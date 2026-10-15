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
    const io: std.Io = .{ .userdata = userdata, .vtable = original_vtable.? };
    if (options.follow_symlinks) return original_vtable.?.dirOpenFile(userdata, dir, path, options);

    // Zig 0.16 opens no-follow handles asynchronously but labels them as
    // synchronous. Merely changing the label cannot support streaming writes:
    // Windows maintains a file position only on synchronous disk handles.
    // Reopen the same object through its handle, without resolving its path.
    var unlocked_options = options;
    unlocked_options.lock = .none;
    const original = try original_vtable.?.dirOpenFile(userdata, dir, path, unlocked_options);
    defer original.close(io);
    const file = try reopenSynchronous(io, original, options);
    errdefer file.close(io);
    if (options.lock != .none) {
        if (options.lock_nonblocking) {
            if (!try file.tryLock(io, options.lock)) return error.WouldBlock;
        } else try file.lock(io, options.lock);
    }
    return file;
}

fn reopenSynchronous(io: std.Io, original: std.Io.File, options: std.Io.Dir.OpenFileOptions) std.Io.File.OpenError!std.Io.File {
    const windows = std.os.windows;
    const attributes: windows.OBJECT.ATTRIBUTES = .{
        .RootDirectory = original.handle,
        .ObjectName = @constCast(&windows.UNICODE_STRING.empty),
    };
    var handle: windows.HANDLE = undefined;
    var status_block: windows.IO_STATUS_BLOCK = undefined;
    while (true) {
        try io.checkCancel();
        switch (windows.ntdll.NtCreateFile(&handle, .{
            .GENERIC = .{ .READ = options.isRead(), .WRITE = options.isWrite() },
            .STANDARD = .{ .SYNCHRONIZE = true },
        }, &attributes, &status_block, null, .{ .NORMAL = true }, .VALID_FLAGS, .OPEN, .{
            .NON_DIRECTORY_FILE = !options.allow_directory or options.isWrite(),
            .IO = .SYNCHRONOUS_NONALERT,
            .OPEN_REPARSE_POINT = true,
        }, null, 0)) {
            .SUCCESS => return .{ .handle = handle, .flags = .{ .nonblocking = false } },
            .CANCELLED => continue,
            .ACCESS_DENIED => return error.AccessDenied,
            .DELETE_PENDING, .SHARING_VIOLATION => return error.FileBusy,
            .OBJECT_NAME_NOT_FOUND, .OBJECT_PATH_NOT_FOUND => return error.FileNotFound,
            .FILE_IS_A_DIRECTORY => return error.IsDir,
            .NOT_A_DIRECTORY => return error.NotDir,
            .INSUFFICIENT_RESOURCES, .NO_MEMORY => return error.SystemResources,
            else => |status| return windows.unexpectedStatus(status),
        }
    }
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
