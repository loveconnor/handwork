const std = @import("std");
const io_mod = @import("../shared/io.zig");
const update_target = @import("update_target.zig");

// Update the package (including runtime assets), not just its executable.
// Deriving the prefix avoids updating a different Node installation on PATH.
pub fn globalPrefix(executable: []const u8) ?[]const u8 {
    const suffix = "/lib/node_modules/handwork/zig-out/bin/handwork";
    if (!std.mem.endsWith(u8, executable, suffix)) return null;
    const prefix = executable[0 .. executable.len - suffix.len];
    if (prefix.len == 0) return "/";
    return if (std.fs.path.isAbsolute(prefix)) prefix else null;
}

pub fn run(alloc: std.mem.Allocator, current: update_target.CurrentBuild) !update_target.Target {
    var exe_buf: [std.fs.max_path_bytes]u8 = undefined;
    const n = std.process.executablePath(io_mod.getIo(), &exe_buf) catch return error.SelfExeNotFound;
    const prefix = globalPrefix(exe_buf[0..n]) orelse return error.NpmInstallRequired;
    const npm = try std.fs.path.join(alloc, &.{ prefix, "bin", "npm" });
    defer alloc.free(npm);
    const latest = std.process.run(alloc, io_mod.getIo(), .{
        .argv = &.{ npm, "view", "handwork@latest", "version", "--registry=https://registry.npmjs.org/" },
    }) catch return error.NpmFetchFailed;
    defer alloc.free(latest.stdout);
    defer alloc.free(latest.stderr);
    if (latest.term != .exited or latest.term.exited != 0) return error.NpmFetchFailed;
    var target = update_target.Target.initStable(alloc, latest.stdout) catch return error.NpmFetchFailed;
    errdefer target.deinit(alloc);
    if (!target.shouldInstall(current)) return target;

    const package = try std.fmt.allocPrint(alloc, "handwork@{s}", .{target.version()});
    defer alloc.free(package);
    const install = std.process.run(alloc, io_mod.getIo(), .{
        .argv = &.{ npm, "install", "--global", "--prefix", prefix, package, "--registry=https://registry.npmjs.org/", "--no-audit", "--no-fund" },
    }) catch return error.NpmInstallFailed;
    defer alloc.free(install.stdout);
    defer alloc.free(install.stderr);
    if (install.term != .exited or install.term.exited != 0) return error.NpmInstallFailed;
    return target;
}

test "npm update identifies only global package executables" {
    try std.testing.expectEqualStrings("/opt/homebrew", globalPrefix("/opt/homebrew/lib/node_modules/handwork/zig-out/bin/handwork").?);
    try std.testing.expectEqualStrings("/Users/test/.nvm/versions/node/v22", globalPrefix("/Users/test/.nvm/versions/node/v22/lib/node_modules/handwork/zig-out/bin/handwork").?);
    try std.testing.expect(globalPrefix("/work/handwork/zig-out/bin/handwork") == null);
    try std.testing.expect(globalPrefix("/work/node_modules/handwork/zig-out/bin/handwork") == null);
    try std.testing.expect(globalPrefix("relative/lib/node_modules/handwork/zig-out/bin/handwork") == null);
}
