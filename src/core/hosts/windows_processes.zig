//! Windows process handles, creation identity and owned command jobs.
const std = @import("std");
const builtin = @import("builtin");
const identity = @import("../execution/process_identity.zig");
const c = if (builtin.os.tag == .windows) @cImport({
    // Import API declarations only: Zig 0.16 cannot translate MinGW's
    // fortified wide-string inline wrappers in ReleaseSafe mode.
    @cDefine("_FORTIFY_SOURCE", "0");
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    @cInclude("windows.h");
    @cInclude("tlhelp32.h");
}) else struct {};
const Handle = std.os.windows.HANDLE;

pub fn currentId() u32 {
    return c.GetCurrentProcessId();
}

pub fn creationTime(handle: Handle) !u64 {
    var created: c.FILETIME = undefined;
    var exit_time: c.FILETIME = undefined;
    var kernel: c.FILETIME = undefined;
    var user: c.FILETIME = undefined;
    if (c.GetProcessTimes(handle, &created, &exit_time, &kernel, &user) == 0) return error.ProcessIdentityUnavailable;
    return (@as(u64, created.dwHighDateTime) << 32) | created.dwLowDateTime;
}

pub fn open(pid: u32, terminate: bool) !Handle {
    if (pid == 0) return error.InvalidPid;
    return c.OpenProcess(@as(u32, c.PROCESS_QUERY_LIMITED_INFORMATION) | @as(u32, c.SYNCHRONIZE) | @as(u32, if (terminate) c.PROCESS_TERMINATE else 0), 0, pid) orelse
        return switch (c.GetLastError()) {
            c.ERROR_INVALID_PARAMETER => error.ProcessNotFound,
            c.ERROR_ACCESS_DENIED => error.PermissionDenied,
            else => error.ProcessIdentityUnavailable,
        };
}

pub fn tokenForHandle(handle: Handle) !identity.ProcessInstanceToken {
    if (try exited(handle)) return error.ProcessNotFound;
    var buffer: [128]u8 = undefined;
    return identity.ProcessInstanceToken.parse(try std.fmt.bufPrint(&buffer, "windows:{d}", .{try creationTime(handle)}));
}

pub fn captureToken(pid: u32) !identity.ProcessInstanceToken {
    const handle = try open(pid, false);
    defer _ = c.CloseHandle(handle);
    return tokenForHandle(handle);
}

pub fn exited(handle: Handle) !bool {
    return switch (c.WaitForSingleObject(handle, 0)) {
        c.WAIT_OBJECT_0 => true,
        c.WAIT_TIMEOUT => false,
        else => error.ProcessIdentityUnavailable,
    };
}

pub const Job = struct {
    handle: Handle,

    /// Child must be suspended until assignment, so descendants cannot escape
    /// into the interval between spawn and job ownership.
    pub fn attachSuspended(child: *std.process.Child) !Job {
        const handle = c.CreateJobObjectW(null, null) orelse return error.JobCreationFailed;
        errdefer _ = c.CloseHandle(handle);
        var limits = std.mem.zeroes(c.JOBOBJECT_EXTENDED_LIMIT_INFORMATION);
        limits.BasicLimitInformation.LimitFlags = c.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (c.SetInformationJobObject(handle, c.JobObjectExtendedLimitInformation, &limits, @sizeOf(@TypeOf(limits))) == 0) return error.JobConfigurationFailed;
        if (c.AssignProcessToJobObject(handle, child.id.?) == 0) return error.JobAssignmentFailed;
        if (c.ResumeThread(child.thread_handle) == std.math.maxInt(u32)) return error.ProcessResumeFailed;
        return .{ .handle = handle };
    }

    pub fn terminate(self: Job) !void {
        if (c.TerminateJobObject(self.handle, 1) == 0) return error.ProcessTerminationFailed;
    }

    pub fn deinit(self: *Job) void {
        _ = c.CloseHandle(self.handle);
        self.* = undefined;
    }
};

/// Bind authorization and termination to the same open process object, rather
/// than reopening a PID after checking its token.
pub fn terminateTree(alloc: std.mem.Allocator, pid: u32, expected: identity.ProcessInstanceToken) !void {
    const root = try open(pid, true);
    defer _ = c.CloseHandle(root);
    if (!(try tokenForHandle(root)).eql(expected)) return error.ProcessIdentityMismatch;
    const Entry = struct { pid: u32, handle: Handle, created: u64 };
    var tree: std.ArrayList(Entry) = .empty;
    defer {
        for (tree.items[@min(1, tree.items.len)..]) |entry| _ = c.CloseHandle(entry.handle);
        tree.deinit(alloc);
    }
    try tree.append(alloc, .{ .pid = pid, .handle = root, .created = try creationTime(root) });
    const snapshot = c.CreateToolhelp32Snapshot(c.TH32CS_SNAPPROCESS, 0);
    if (snapshot == c.INVALID_HANDLE_VALUE) return error.ProcessIdentityUnavailable;
    defer _ = c.CloseHandle(snapshot);
    var cursor: usize = 0;
    while (cursor < tree.items.len) : (cursor += 1) {
        const parent = tree.items[cursor];
        var info = std.mem.zeroes(c.PROCESSENTRY32W);
        info.dwSize = @sizeOf(@TypeOf(info));
        var more = c.Process32FirstW(snapshot, &info) != 0;
        while (more) : (more = c.Process32NextW(snapshot, &info) != 0) {
            if (info.th32ParentProcessID != parent.pid or info.th32ProcessID == pid) continue;
            var known = false;
            for (tree.items) |entry| if (entry.pid == info.th32ProcessID) {
                known = true;
                break;
            };
            if (known) continue;
            const child = open(info.th32ProcessID, true) catch |err| switch (err) {
                error.ProcessNotFound => continue,
                else => return err,
            };
            errdefer _ = c.CloseHandle(child);
            const created = try creationTime(child);
            if (created < parent.created or try exited(parent.handle)) {
                _ = c.CloseHandle(child);
                continue;
            }
            try tree.append(alloc, .{ .pid = info.th32ProcessID, .handle = child, .created = created });
        }
    }
    var index = tree.items.len;
    while (index != 0) {
        index -= 1;
        const handle = tree.items[index].handle;
        if (!try exited(handle) and c.TerminateProcess(handle, 1) == 0) return error.PermissionDenied;
    }
}

test "Windows process jobs bind identity and terminate owned descendants" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    var child = try std.process.spawn(std.testing.io, .{
        .argv = &.{ "cmd.exe", "/D", "/S", "/C", "ping -n 30 127.0.0.1 >nul" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .start_suspended = true,
    });
    defer if (child.id != null) child.kill(std.testing.io);
    const original = try tokenForHandle(child.id.?);
    const numeric_pid = c.GetProcessId(child.id.?);
    try std.testing.expect(original.eql(try captureToken(numeric_pid)));
    const wrong = try identity.ProcessInstanceToken.parse("windows:1");
    try std.testing.expectError(error.ProcessIdentityMismatch, terminateTree(std.testing.allocator, numeric_pid, wrong));
    try std.testing.expect(!try exited(child.id.?));
    var job = try Job.attachSuspended(&child);
    defer job.deinit();
    try std.testing.expect(!try exited(child.id.?));
    var accounting: c.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = undefined;
    var spawned = false;
    for (0..500) |_| {
        if (c.QueryInformationJobObject(job.handle, c.JobObjectBasicAccountingInformation, &accounting, @sizeOf(@TypeOf(accounting)), null) == 0) return error.JobQueryFailed;
        if (accounting.ActiveProcesses >= 2) {
            spawned = true;
            break;
        }
        c.Sleep(10);
    }
    try std.testing.expect(spawned);
    try job.terminate();
    try std.testing.expectEqual(@as(u32, c.WAIT_OBJECT_0), c.WaitForSingleObject(child.id.?, 5000));
    _ = try child.wait(std.testing.io);
    var info: c.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = undefined;
    var tries: usize = 0;
    while (tries < 100) : (tries += 1) {
        if (c.QueryInformationJobObject(job.handle, c.JobObjectBasicAccountingInformation, &info, @sizeOf(@TypeOf(info)), null) == 0) return error.JobQueryFailed;
        if (info.ActiveProcesses == 0) break;
        c.Sleep(10);
    }
    try std.testing.expectEqual(@as(u32, 0), info.ActiveProcesses);
}
