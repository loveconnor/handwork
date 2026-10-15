//! Storage and command journeys shared by native Windows and macOS checks.
const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("core/shared/io.zig");
const settings = @import("core/config/settings_store.zig");
const history = @import("core/session/prompt_history_store.zig");
const sessions = @import("core/session/session_store.zig");
const codec = @import("core/session/session_codec.zig");
const session = @import("core/session/session.zig");
const types = @import("core/shared/types.zig");
const commands = @import("core/execution/command_runner.zig");
const shells = @import("core/terminal/shell_resolver.zig");

test "platform integration persists settings history and a resumable session in Unicode paths" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "日本語 home");
    try tmp.dir.createDirPath(io_mod.getIo(), "日本語 workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "日本語 home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "日本語 workspace");
    defer alloc.free(workspace);
    {
        var store = try settings.Store.initFromHome(alloc, home, .writable);
        defer store.deinit(alloc);
        var outcome = try store.applyUserPatch(alloc, .{ .startup_scrollback = false });
        defer outcome.deinit(alloc);
    }
    {
        var store = try settings.Store.initFromHome(alloc, home, .read_only);
        defer store.deinit(alloc);
        const bytes = try store.readPrimaryForTest(alloc);
        defer alloc.free(bytes);
        const parsed = try std.json.parseFromSlice(std.json.Value, alloc, bytes, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(false, parsed.value.object.get("startup_scrollback").?.bool);
    }
    {
        var store = try history.Store.initFromHome(alloc, home);
        defer store.deinit(alloc);
        _ = try store.append(alloc, 100, workspace, "resume 日本語");
    }
    {
        var store = try history.Store.initFromHome(alloc, home);
        defer store.deinit(alloc);
        const entries = try store.loadRecentForWorkspace(alloc, workspace, 10);
        defer history.freeLoadedEntries(alloc, entries);
        try std.testing.expectEqual(@as(usize, 1), entries.len);
        try std.testing.expectEqualStrings("resume 日本語", entries[0].text);
    }
    var store = try sessions.Store.initFromHome(alloc, home, workspace);
    defer store.deinit(alloc);
    var state: codec.DurableSessionState = .{
        .id = try alloc.dupe(u8, "platform-resume"),
        .origin_workspace_root = try alloc.dupe(u8, workspace),
        .workspace_root = try alloc.dupe(u8, workspace),
        .created_at_ms = 100,
        .updated_at_ms = 100,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{ .model = try alloc.dupe(u8, "test/model"), .effort = types.ReasoningEffort.literal("high"), .fast_mode = false },
        .history = &.{},
        .total_input_tokens = 0,
        .total_output_tokens = 0,
    };
    defer state.deinit(alloc);
    {
        var writable = try store.startWritableSession(alloc, state);
        defer writable.deinit(alloc);
        try store.rememberSessionId(alloc, writable.active_id);
    }
    const remembered = (try store.readRememberedSessionId(alloc)).?;
    defer alloc.free(remembered);
    var resumed = try store.resumeForWrite(alloc, remembered);
    defer resumed.deinit(alloc);
    try std.testing.expectEqualStrings("platform-resume", resumed.active_id);
    try std.testing.expectEqualStrings(workspace, resumed.state.workspace_root);
}

test "platform integration Windows commands preserve quotes streams exit and timeout" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "日本語 %PATH% & workspace");
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "日本語 %PATH% & workspace");
    defer alloc.free(workspace);
    var environment = try std.process.Environ.createMap(.{ .block = .global }, alloc);
    defer environment.deinit();
    try environment.put("TEMP", workspace);
    io_mod.setEnvironMap(&environment);
    defer io_mod.setEnvironBlock(.global);
    var shell_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const shell = shells.configuredLoginShellInto(&shell_buffer).?;
    const result = try commands.executeCommandInEnvironment(.{ .max_command_output_bytes = 4096 }, alloc, "echo \"quoted 日本語\"\r\necho stderr-marker 1>&2\r\nexit /b 7", workspace, .{ .clean = shell });
    defer alloc.free(result.output);
    try std.testing.expect(std.mem.indexOf(u8, result.output, "exit_code=7") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.output, "\"quoted 日本語\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.output, "<stderr>\nstderr-marker") != null);
    try std.testing.expectError(error.TimeoutExpired, commands.executeCommand(.{ .max_command_output_bytes = 4096, .timeout_ms = 200 }, alloc, "ping -n 30 127.0.0.1 >nul", workspace));
}

test "platform integration private read snapshots survive unlink while mutation handles reject it" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try io_mod.createPrivateFile(tmp.dir, io_mod.getIo(), "snapshot", .{ .exclusive = true });
    defer file.close(io_mod.getIo());
    try file.writeStreamingAll(io_mod.getIo(), "retained");
    try tmp.dir.deleteFile(io_mod.getIo(), "snapshot");
    try io_mod.verifyReadOnlyPrivateRegularFile(file);
    try std.testing.expectError(error.DurablePathUnsafe, io_mod.verifyPrivateRegularFile(file));
}
