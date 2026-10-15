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
    errdefer |err| std.debug.print("storage integration failed: {s}\n", .{@errorName(err)});
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
    errdefer |err| std.debug.print("Windows command integration failed: {s}\n", .{@errorName(err)});
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
    const powershell = try std.fs.path.join(alloc, &.{ std.fs.path.dirname(shell).?, "WindowsPowerShell", "v1.0", "powershell.exe" });
    defer alloc.free(powershell);
    const close_pipes =
        \\Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ClosePipes { [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }';
        \\[ClosePipes]::CloseHandle([ClosePipes]::GetStdHandle(-11)) | Out-Null;
        \\[ClosePipes]::CloseHandle([ClosePipes]::GetStdHandle(-12)) | Out-Null;
        \\[IO.File]::WriteAllText('closed.marker', 'ready');
        \\Start-Sleep -Seconds 8
    ;
    try std.testing.expectError(error.TimeoutExpired, commands.executeCommandInEnvironment(.{ .max_command_output_bytes = 4096, .timeout_ms = 5000 }, alloc, close_pipes, workspace, .{ .clean = powershell }));
    try tmp.dir.access(io_mod.getIo(), "日本語 %PATH% & workspace/closed.marker", .{});
}

test "platform integration private read snapshots survive unlink while mutation handles reject it" {
    errdefer |err| std.debug.print("snapshot integration failed: {s}\n", .{@errorName(err)});
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try io_mod.createPrivateFile(tmp.dir, io_mod.getIo(), "snapshot", .{ .exclusive = true });
    defer file.close(io_mod.getIo());
    try file.writeStreamingAll(io_mod.getIo(), "retained");
    try tmp.dir.deleteFile(io_mod.getIo(), "snapshot");
    try io_mod.verifyReadOnlyPrivateRegularFile(file);
    try std.testing.expectError(error.DurablePathUnsafe, io_mod.verifyPrivateRegularFile(file));
}

test "platform integration public DNS and HTTPS use system certificate trust" {
    // Opt in on hosts with Internet access; all local fixture checks stay
    // available offline. CI already downloads its compiler from this host.
    const alloc = std.testing.allocator;
    const enabled = std.testing.environ.getAlloc(alloc, "HANDWORK_E2E_PUBLIC_HTTPS") catch |err| switch (err) {
        error.EnvironmentVariableMissing => return error.SkipZigTest,
        else => return err,
    };
    defer alloc.free(enabled);
    if (!std.mem.eql(u8, enabled, "1")) return error.SkipZigTest;
    errdefer |err| std.debug.print("DNS/TLS integration failed: {s}\n", .{@errorName(err)});
    const http = @import("tools/web/http_fetch.zig");
    const policy = @import("tools/web/url_policy.zig");
    var url = try policy.normalize(alloc, "https://ziglang.org/download/index.json");
    defer url.deinit(alloc);
    var result = try http.fetch(alloc, url, .{
        .max_body_bytes = 2 * 1024 * 1024,
        .deadline = .{ .deadline_ms = io_mod.milliTimestamp() + 20_000 },
    }, http.defaultTransport());
    defer result.deinit(alloc);
    switch (result) {
        .success => |success| {
            try std.testing.expectEqual(std.http.Status.ok, success.status);
            const parsed = try std.json.parseFromSlice(std.json.Value, alloc, success.body, .{});
            defer parsed.deinit();
            try std.testing.expect(parsed.value.object.contains("0.16.0"));
        },
        else => return error.HttpsFetchFailed,
    }
}
