const std = @import("std");
const server = @import("server.zig");
const jsonrpc = @import("jsonrpc.zig");
const settings_store = @import("../core/config/settings_store.zig");
const config_runtime = @import("../core/config/config_runtime.zig");
const workspace_access = @import("../core/workspace/workspace_access.zig");
const io_mod = @import("../core/shared/io.zig");
const types = @import("../core/shared/types.zig");
const Allocator = std.mem.Allocator;

const PermissionRequest = struct { project: bool, category: []const u8, action: ?types.PermissionAction };
fn permissionRequest(value: std.json.Value) !PermissionRequest {
    if (value != .object) return error.InvalidParams;
    const scope = value.object.get("scope") orelse return error.InvalidParams;
    const category = value.object.get("category") orelse return error.InvalidParams;
    const action = value.object.get("action") orelse return error.InvalidParams;
    if (scope != .string or category != .string or action != .string) return error.InvalidParams;
    if (!std.mem.eql(u8, scope.string, "app") and !std.mem.eql(u8, scope.string, "project")) return error.InvalidParams;
    var known = false;
    for ([_][]const u8{ "read", "edit", "bash", "web_fetch", "web_search" }) |name| {
        if (std.mem.eql(u8, name, category.string)) {
            known = true;
            break;
        }
    }
    if (!known) return error.InvalidParams;
    const mode: ?types.PermissionAction = if (std.mem.eql(u8, action.string, "inherit")) null else if (std.mem.eql(u8, action.string, "ask")) .ask else if (std.mem.eql(u8, action.string, "allow")) .allow else if (std.mem.eql(u8, action.string, "deny")) .deny else return error.InvalidParams;
    return .{ .project = std.mem.eql(u8, scope.string, "project"), .category = category.string, .action = mode };
}

pub fn handlePermission(state: *server.ServerState, alloc: Allocator, msg: *jsonrpc.Message) !void {
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, msg.params_raw orelse "null", .{}) catch return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid permission preference" });
    defer parsed.deinit();
    const request = permissionRequest(parsed.value) catch return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid permission preference" });
    const home = state.cfg.home_override orelse io_mod.getenv("HOME") orelse return error.MissingHome;
    var store = try settings_store.Store.initFromHome(alloc, home, .writable);
    defer store.deinit(alloc);
    var outcome = store.applyPermissionPatch(alloc, .{
        .scope = if (request.project) .local else .user,
        .workspace_root = if (request.project) state.workspace_root else null,
        .patch = if (request.action) |action| .{ .add = .{ .category = request.category, .pattern = "*", .action = action } } else .{ .remove = .{ .category = request.category, .pattern = "*" } },
    }) catch return state.writer.writeError(alloc, msg.id, .{ .code = -32603, .message = "Could not save permission preference" });
    defer outcome.deinit(alloc);
    try state.writer.writeResponse(alloc, msg.id, "{\"reconnectRequired\":true}");
}

pub fn handleDirectory(state: *server.ServerState, alloc: Allocator, msg: *jsonrpc.Message) !void {
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, msg.params_raw orelse "null", .{}) catch return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid project folder" });
    defer parsed.deinit();
    const value = parsed.value;
    if (value != .object) return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid project folder" });
    const action = value.object.get("action") orelse return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid project folder" });
    const folder = value.object.get("path") orelse return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid project folder" });
    if (action != .string or folder != .string or !std.fs.path.isAbsolute(folder.string) or folder.string.len > 4096 or std.mem.indexOfScalar(u8, folder.string, 0) != null) return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid project folder" });
    const adding = std.mem.eql(u8, action.string, "add");
    if (!adding and !std.mem.eql(u8, action.string, "remove")) return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Invalid project folder" });
    const identity = (if (adding) workspace_access.addDirectoryIdentityAlloc(alloc, state.workspace_root, folder.string) else workspace_access.storedDirectoryIdentityAlloc(alloc, state.workspace_root, folder.string)) catch return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "Project folder is unavailable or invalid" });
    defer alloc.free(identity);
    if (std.mem.eql(u8, identity, state.workspace_root)) return state.writer.writeError(alloc, msg.id, .{ .code = -32602, .message = "The primary project folder is already allowed" });
    const patch: settings_store.WorkspaceDirectoryPatch = if (adding) .{ .add = identity } else .{ .remove = identity };
    const home = state.cfg.home_override orelse io_mod.getenv("HOME") orelse return error.MissingHome;
    var store = try settings_store.Store.initFromHome(alloc, home, .writable);
    defer store.deinit(alloc);
    var detailed = try config_runtime.loadMergedSettingsDetailedFromHome(alloc, home, state.workspace_root);
    defer detailed.deinit(alloc);
    var current = try workspace_access.WorkspaceAccess.init(alloc, state.workspace_root, detailed.additional_directory_sources orelse &.{}, &.{}, false);
    defer current.deinit(alloc);
    var outcome = store.applyWorkspaceDirectoryPatch(alloc, .{ .workspace_root = state.workspace_root, .patch = patch, .observed_sources = current.saved_sources }) catch return state.writer.writeError(alloc, msg.id, .{ .code = -32603, .message = "Could not save project folder" });
    defer outcome.deinit(alloc);
    try state.writer.writeResponse(alloc, msg.id, "{\"reconnectRequired\":true}");
}

test "desktop permission preferences reject arbitrary categories and require explicit scope" {
    const alloc = std.testing.allocator;
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, "{\"scope\":\"project\",\"category\":\"bash\",\"action\":\"deny\"}", .{});
    defer parsed.deinit();
    const request = try permissionRequest(parsed.value);
    try std.testing.expect(request.project);
    try std.testing.expectEqual(types.PermissionAction.deny, request.action.?);
    var invalid = try std.json.parseFromSlice(std.json.Value, alloc, "{\"scope\":\"project\",\"category\":\"anything\",\"action\":\"allow\"}", .{});
    defer invalid.deinit();
    try std.testing.expectError(error.InvalidParams, permissionRequest(invalid.value));
}
