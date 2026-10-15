//! Canonical paths through Zig's native handle-based Windows I/O backend.
const std = @import("std");

pub fn filePath(zio: std.Io, alloc: std.mem.Allocator, file: std.Io.File) ![]u8 {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const len = try file.realPath(zio, &buffer);
    return alloc.dupe(u8, buffer[0..len]);
}

pub fn dirPath(zio: std.Io, alloc: std.mem.Allocator, dir: std.Io.Dir, sub_path: []const u8) ![]u8 {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const len = if (sub_path.len == 0)
        try dir.realPath(zio, &buffer)
    else
        try dir.realPathFile(zio, sub_path, &buffer);
    return alloc.dupe(u8, buffer[0..len]);
}

test "Windows path adapter preserves Unicode and spaces and follows an open handle across rename" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "日本語 file.txt", .data = "fixture" });
    const file = try tmp.dir.openFile(std.testing.io, "日本語 file.txt", .{});
    defer file.close(std.testing.io);
    const from_handle = try filePath(std.testing.io, alloc, file);
    defer alloc.free(from_handle);
    const from_dir = try dirPath(std.testing.io, alloc, tmp.dir, "日本語 file.txt");
    defer alloc.free(from_dir);
    try std.testing.expect(std.fs.path.isAbsolute(from_handle));
    try std.testing.expectEqualStrings(from_handle, from_dir);
    try std.testing.expect(std.mem.endsWith(u8, from_handle, "日本語 file.txt"));
    try tmp.dir.rename("日本語 file.txt", tmp.dir, "renamed file.txt", std.testing.io);
    const renamed = try filePath(std.testing.io, alloc, file);
    defer alloc.free(renamed);
    try std.testing.expect(std.mem.endsWith(u8, renamed, "renamed file.txt"));
    const dir_from_handle = try dirPath(std.testing.io, alloc, tmp.dir, "");
    defer alloc.free(dir_from_handle);
    const dir_from_dot = try dirPath(std.testing.io, alloc, tmp.dir, ".");
    defer alloc.free(dir_from_dot);
    try std.testing.expectEqualStrings(dir_from_handle, dir_from_dot);
    try std.testing.expectError(error.FileNotFound, dirPath(std.testing.io, alloc, tmp.dir, "missing"));
}
