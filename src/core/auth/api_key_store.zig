//! Provider-scoped secrets in verified private files, outside settings and history.
const std = @import("std");
const io = @import("../shared/io.zig");
const config = @import("../config/api_providers.zig");
const model = @import("../config/model_provider.zig");
const secret = @import("secret.zig");
const target = @import("../hosts/target.zig");
fn directory(create: bool) !io.VerifiedDir {
    if (comptime target.is_wasm) return error.CredentialStorageUnavailable;
    const home = io.getenv("HOME") orelse return error.HomeNotSet;
    var parent: io.VerifiedDir = .{ .dir = try std.Io.Dir.openDirAbsolute(io.getIo(), home, .{}) };
    defer parent.close();
    if (create) return io.openOrCreateVerifiedPrivateDir(&parent, ".handwork");
    return .{ .dir = try parent.dir.openDir(io.getIo(), ".handwork", .{ .follow_symlinks = false }) };
}
fn filename(alloc: std.mem.Allocator, id: model.ProviderId) ![]u8 {
    const entry = config.find(id) orelse return error.InvalidProvider;
    if (entry.anonymous) return error.InvalidProvider;
    return std.fmt.allocPrint(alloc, "api-key-{s}", .{@tagName(id)});
}
pub fn load(alloc: std.mem.Allocator, id: model.ProviderId) !?[]u8 {
    var dir = directory(false) catch |err| switch (err) {
        error.FileNotFound, error.HomeNotSet => return null,
        else => return err,
    };
    defer dir.close();
    const name = try filename(alloc, id);
    defer alloc.free(name);
    var file = dir.dir.openFile(io.getIo(), name, .{ .allow_directory = false, .follow_symlinks = false, .resolve_beneath = true }) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer file.close(io.getIo());
    const stat = try file.stat(io.getIo());
    if (stat.kind != .file or stat.nlink != 1 or stat.permissions.toMode() & 0o077 != 0) return error.InsecureAuthFile;
    const key = try io.readFileToEnd(alloc, &file, 8192);
    errdefer secret.zeroAndFree(alloc, key);
    if (!config.validProviderKey(id, key)) return error.InvalidApiKey;
    return key;
}
pub fn save(alloc: std.mem.Allocator, id: model.ProviderId, key: []const u8) !void {
    try @import("../config/provider_policy.zig").requireNative(id);
    if (!config.validProviderKey(id, key)) return error.InvalidApiKey;
    var dir = try directory(true);
    defer dir.close();
    const name = try filename(alloc, id);
    defer alloc.free(name);
    try io.durableReplaceVerified(alloc, &dir, name, key);
}
pub fn remove(alloc: std.mem.Allocator, id: model.ProviderId) !void {
    var dir = directory(false) catch |err| switch (err) {
        error.FileNotFound, error.HomeNotSet => return,
        else => return err,
    };
    defer dir.close();
    const name = try filename(alloc, id);
    defer alloc.free(name);
    dir.dir.deleteFile(io.getIo(), name) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    const durable: io.DurableOps = .{};
    try durable.sync_dir(durable.ctx, dir.dir);
}
