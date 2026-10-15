const std = @import("std");
const io_mod = @import("../shared/io.zig");
const update_target = @import("update_target.zig");

// Update the package (including runtime assets), not just its executable.
// Deriving the prefix avoids updating a different Node installation on PATH.
pub fn globalPrefix(executable: []const u8) ?[]const u8 {
    return globalPrefixForOs(@import("builtin").os.tag, executable);
}

fn globalPrefixForOs(comptime os: std.Target.Os.Tag, executable: []const u8) ?[]const u8 {
    const suffixes = if (os == .windows) &[_][]const u8{
        "\\node_modules\\handwork\\prebuilds\\win32-x64\\bin\\handwork.exe",
        "\\node_modules\\handwork\\prebuilds\\win32-arm64\\bin\\handwork.exe",
        "\\node_modules\\handwork\\zig-out\\bin\\handwork.exe",
    } else &[_][]const u8{
        "/lib/node_modules/handwork/prebuilds/darwin-arm64/bin/handwork",
        "/lib/node_modules/handwork/zig-out/bin/handwork",
    };
    for (suffixes) |suffix| {
        if (executable.len < suffix.len) continue;
        const tail = executable[executable.len - suffix.len ..];
        const matches = if (os == .windows) std.ascii.eqlIgnoreCase(tail, suffix) else std.mem.eql(u8, tail, suffix);
        if (!matches) continue;
        const prefix = executable[0 .. executable.len - suffix.len];
        if (os == .windows) return if (std.fs.path.isAbsoluteWindows(prefix)) prefix else null;
        if (prefix.len == 0) return "/";
        return if (std.fs.path.isAbsolutePosix(prefix)) prefix else null;
    }
    return null;
}

pub fn run(alloc: std.mem.Allocator, current: update_target.CurrentBuild) !update_target.Target {
    var exe_buf: [std.fs.max_path_bytes]u8 = undefined;
    const n = std.process.executablePath(io_mod.getIo(), &exe_buf) catch return error.SelfExeNotFound;
    const prefix = globalPrefix(exe_buf[0..n]) orelse return error.NpmInstallRequired;
    const npm = if (@import("builtin").os.tag == .windows) try alloc.dupe(u8, "npm.cmd") else try std.fs.path.join(alloc, &.{ prefix, "bin", "npm" });
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
    try std.testing.expectEqualStrings("/opt/homebrew", globalPrefixForOs(.macos, "/opt/homebrew/lib/node_modules/handwork/zig-out/bin/handwork").?);
    try std.testing.expectEqualStrings("/Users/test/.nvm/versions/node/v22", globalPrefixForOs(.macos, "/Users/test/.nvm/versions/node/v22/lib/node_modules/handwork/zig-out/bin/handwork").?);
    try std.testing.expect(globalPrefixForOs(.macos, "/work/handwork/zig-out/bin/handwork") == null);
    try std.testing.expect(globalPrefixForOs(.macos, "/work/node_modules/handwork/zig-out/bin/handwork") == null);
    try std.testing.expect(globalPrefix("relative/lib/node_modules/handwork/zig-out/bin/handwork") == null);
}

test "npm update recognizes staged Windows packages and rejects local installations" {
    try std.testing.expectEqualStrings("C:\\Users\\Renée\\AppData\\Roaming\\npm", globalPrefixForOs(.windows, "C:\\Users\\Renée\\AppData\\Roaming\\npm\\node_modules\\handwork\\prebuilds\\win32-x64\\bin\\handwork.exe").?);
    try std.testing.expectEqualStrings("D:\\node", globalPrefixForOs(.windows, "D:\\node\\node_modules\\handwork\\prebuilds\\win32-arm64\\bin\\handwork.exe").?);
    try std.testing.expect(globalPrefixForOs(.windows, "C:\\repo\\zig-out\\bin\\handwork.exe") == null);
    try std.testing.expect(globalPrefixForOs(.windows, "relative\\node_modules\\handwork\\zig-out\\bin\\handwork.exe") == null);
    try std.testing.expectEqualStrings("/opt/homebrew", globalPrefixForOs(.macos, "/opt/homebrew/lib/node_modules/handwork/prebuilds/darwin-arm64/bin/handwork").?);
}
