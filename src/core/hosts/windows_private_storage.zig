//! Handle-relative private storage. ACLs are supplied at creation, before any
//! bytes are written; no path-based chmod or shell command is involved.
const std = @import("std");
const builtin = @import("builtin");
const windows = std.os.windows;
const c = if (builtin.os.tag == .windows) @cImport({
    // Import API declarations only: Zig 0.16 cannot translate MinGW's
    // fortified wide-string inline wrappers in ReleaseSafe mode.
    @cDefine("_FORTIFY_SOURCE", "0");
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    @cInclude("windows.h");
    @cInclude("aclapi.h");
}) else struct {};

pub const OpenedDir = struct { dir: std.Io.Dir, created: bool };

fn validateLeaf(name: []const u8) !void {
    if (name.len == 0 or std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..") or
        std.mem.indexOfAny(u8, name, "/\\:\x00") != null) return error.DurablePathUnsafe;
}

const Sid = struct {
    bytes: [68]u8 align(4) = undefined,

    fn ptr(self: *const Sid) *anyopaque {
        return @ptrCast(@constCast(&self.bytes));
    }

    fn current() !Sid {
        var token: c.HANDLE = null;
        if (c.OpenProcessToken(c.GetCurrentProcess(), c.TOKEN_QUERY, &token) == 0) return error.PrivateStatePermissionsUnsupported;
        defer _ = c.CloseHandle(token);
        var buffer: [512]u8 align(@alignOf(c.TOKEN_USER)) = undefined;
        var length: u32 = 0;
        if (c.GetTokenInformation(token, c.TokenUser, &buffer, buffer.len, &length) == 0) return error.PrivateStatePermissionsUnsupported;
        const user: *const c.TOKEN_USER = @ptrCast(&buffer);
        var sid: Sid = .{};
        if (c.CopySid(sid.bytes.len, sid.ptr(), user.User.Sid) == 0) return error.PrivateStatePermissionsUnsupported;
        return sid;
    }

    fn system() !Sid {
        var sid: Sid = .{};
        var length: u32 = sid.bytes.len;
        if (c.CreateWellKnownSid(c.WinLocalSystemSid, null, sid.ptr(), &length) == 0) return error.PrivateStatePermissionsUnsupported;
        return sid;
    }
};

const Security = struct {
    user: Sid,
    system: Sid,
    acl_bytes: [256]u8 align(4),
    descriptor: c.SECURITY_DESCRIPTOR,

    // Initialize in place: the descriptor borrows the SID and ACL storage.
    fn init(self: *Security, directory: bool) !void {
        self.user = try Sid.current();
        self.system = try Sid.system();
        const acl_ptr: *c.ACL = @ptrCast(&self.acl_bytes);
        const flags: u32 = if (directory) c.OBJECT_INHERIT_ACE | c.CONTAINER_INHERIT_ACE else 0;
        if (c.InitializeAcl(acl_ptr, self.acl_bytes.len, c.ACL_REVISION) == 0 or
            c.AddAccessAllowedAceEx(acl_ptr, c.ACL_REVISION, flags, c.FILE_ALL_ACCESS, self.user.ptr()) == 0 or
            c.AddAccessAllowedAceEx(acl_ptr, c.ACL_REVISION, flags, c.FILE_ALL_ACCESS, self.system.ptr()) == 0 or
            c.InitializeSecurityDescriptor(&self.descriptor, c.SECURITY_DESCRIPTOR_REVISION) == 0 or
            c.SetSecurityDescriptorOwner(&self.descriptor, self.user.ptr(), 0) == 0 or
            c.SetSecurityDescriptorDacl(&self.descriptor, 1, acl_ptr, 0) == 0 or
            c.SetSecurityDescriptorControl(&self.descriptor, c.SE_DACL_PROTECTED, c.SE_DACL_PROTECTED) == 0)
            return error.PrivateStatePermissionsUnsupported;
    }

    fn acl(self: *Security) *c.ACL {
        return @ptrCast(&self.acl_bytes);
    }
};

/// Reject reparse points, hard-linked files, foreign ownership, missing DACLs,
/// inherited ACL policy, and any grant to a principal other than this user or
/// SYSTEM. Unknown ACE types fail closed rather than being guessed at.
pub fn verify(handle: windows.HANDLE, directory: bool) !void {
    return verifyWithLinks(handle, directory, false);
}

pub fn verifyReadOnlyFile(handle: windows.HANDLE) !void {
    return verifyWithLinks(handle, false, true);
}

fn verifyWithLinks(handle: windows.HANDLE, directory: bool, allow_unlinked: bool) !void {
    var info: c.BY_HANDLE_FILE_INFORMATION = undefined;
    if (c.GetFileInformationByHandle(handle, &info) == 0) return error.PrivateStatePermissionsUnsupported;
    if (info.dwFileAttributes & c.FILE_ATTRIBUTE_REPARSE_POINT != 0 or
        (info.dwFileAttributes & c.FILE_ATTRIBUTE_DIRECTORY != 0) != directory or
        (!directory and (info.nNumberOfLinks > 1 or (!allow_unlinked and info.nNumberOfLinks != 1)))) return error.DurablePathUnsafe;
    const user = try Sid.current();
    const system = try Sid.system();
    var owner: c.PSID = null;
    var dacl: c.PACL = null;
    var descriptor: c.PSECURITY_DESCRIPTOR = null;
    if (c.GetSecurityInfo(handle, c.SE_FILE_OBJECT, c.OWNER_SECURITY_INFORMATION | c.DACL_SECURITY_INFORMATION, &owner, null, &dacl, null, &descriptor) != c.ERROR_SUCCESS) return error.PrivateStatePermissionsUnsupported;
    defer _ = c.LocalFree(descriptor);
    if (owner == null or dacl == null or c.EqualSid(owner, user.ptr()) == 0) return error.PrivateStatePermissionsUnsupported;
    var control: c.SECURITY_DESCRIPTOR_CONTROL = 0;
    var revision: u32 = 0;
    if (c.GetSecurityDescriptorControl(descriptor, &control, &revision) == 0 or
        control & c.SE_DACL_PROTECTED == 0) return error.PrivateStatePermissionsUnsupported;
    var user_full_access = false;
    for (0..dacl.*.AceCount) |index| {
        var raw_ace: ?*anyopaque = null;
        if (c.GetAce(dacl, @intCast(index), &raw_ace) == 0) return error.PrivateStatePermissionsUnsupported;
        const ace: *const c.ACCESS_ALLOWED_ACE = @ptrCast(@alignCast(raw_ace.?));
        if (ace.Header.AceType != c.ACCESS_ALLOWED_ACE_TYPE or ace.Header.AceSize < @sizeOf(c.ACCESS_ALLOWED_ACE))
            return error.PrivateStatePermissionsUnsupported;
        const sid: *anyopaque = @ptrCast(@constCast(&ace.SidStart));
        const is_user = c.EqualSid(sid, user.ptr()) != 0;
        if (!is_user and c.EqualSid(sid, system.ptr()) == 0) return error.PrivateStatePermissionsUnsupported;
        if (is_user and ace.Header.AceFlags & c.INHERIT_ONLY_ACE == 0 and
            ace.Mask & c.FILE_ALL_ACCESS == c.FILE_ALL_ACCESS) user_full_access = true;
    }
    if (!user_full_access) return error.PrivateStatePermissionsUnsupported;
}

fn protect(handle: windows.HANDLE, directory: bool) !void {
    // The handle is opened with WRITE_DAC. Existing objects must belong to the
    // current user before their permissions may be changed.
    const user = try Sid.current();
    var owner: c.PSID = null;
    var descriptor: c.PSECURITY_DESCRIPTOR = null;
    if (c.GetSecurityInfo(handle, c.SE_FILE_OBJECT, c.OWNER_SECURITY_INFORMATION, &owner, null, null, null, &descriptor) != c.ERROR_SUCCESS) return error.PrivateStatePermissionsUnsupported;
    defer _ = c.LocalFree(descriptor);
    if (owner == null or c.EqualSid(owner, user.ptr()) == 0) return error.PrivateStatePermissionsUnsupported;
    var security: Security = undefined;
    try security.init(directory);
    if (c.SetSecurityInfo(handle, c.SE_FILE_OBJECT, c.DACL_SECURITY_INFORMATION | c.PROTECTED_DACL_SECURITY_INFORMATION, null, null, security.acl(), null) != c.ERROR_SUCCESS) return error.PrivateStatePermissionsUnsupported;
    try verify(handle, directory);
}

const Opened = struct { handle: windows.HANDLE, created: bool };

fn open(zio: std.Io, parent: std.Io.Dir, name: []const u8, directory: bool, creation: windows.FILE.CREATE_DISPOSITION) !Opened {
    try validateLeaf(name);
    try zio.checkCancel();
    var wide: [windows.PATH_MAX_WIDE]u16 = undefined;
    const length = try windows.wtf8ToWtf16Le(&wide, name);
    var security: Security = undefined;
    try security.init(directory);
    const attributes: windows.OBJECT.ATTRIBUTES = .{
        .RootDirectory = parent.handle,
        .ObjectName = @constCast(&windows.UNICODE_STRING.init(wide[0..length])),
        .Attributes = .{ .CASE_INSENSITIVE = true },
        .SecurityDescriptor = &security.descriptor,
    };
    var handle: windows.HANDLE = undefined;
    var iosb: windows.IO_STATUS_BLOCK = undefined;
    const status = windows.ntdll.NtCreateFile(&handle, .{
        .GENERIC = .{ .READ = true, .WRITE = true },
        .STANDARD = .{ .SYNCHRONIZE = true, .RIGHTS = .{ .READ_CONTROL = true, .WRITE_DAC = true } },
    }, &attributes, &iosb, null, .{ .NORMAL = true }, .VALID_FLAGS, creation, .{
        .DIRECTORY_FILE = directory,
        .NON_DIRECTORY_FILE = !directory,
        .IO = .SYNCHRONOUS_NONALERT,
        .OPEN_REPARSE_POINT = true,
    }, null, 0);
    switch (status) {
        .SUCCESS => {},
        .OBJECT_NAME_COLLISION => return error.PathAlreadyExists,
        .OBJECT_NAME_NOT_FOUND, .OBJECT_PATH_NOT_FOUND => return error.FileNotFound,
        .ACCESS_DENIED => return error.AccessDenied,
        .NOT_A_DIRECTORY => return error.NotDir,
        .FILE_IS_A_DIRECTORY => return error.IsDir,
        .CANCELLED => return error.Cancelled,
        else => return error.PrivateStatePermissionsUnsupported,
    }
    errdefer windows.CloseHandle(handle);
    // Check object type and links before touching an existing object's ACL.
    var info: c.BY_HANDLE_FILE_INFORMATION = undefined;
    if (c.GetFileInformationByHandle(handle, &info) == 0 or
        info.dwFileAttributes & c.FILE_ATTRIBUTE_REPARSE_POINT != 0 or
        (!directory and info.nNumberOfLinks != 1)) return error.DurablePathUnsafe;
    try protect(handle, directory);
    return .{ .handle = handle, .created = iosb.Information == 2 }; // FILE_CREATED.
}

pub fn openOrCreateDir(zio: std.Io, parent: std.Io.Dir, name: []const u8) !OpenedDir {
    const opened = try open(zio, parent, name, true, .OPEN_IF);
    return .{ .dir = .{ .handle = opened.handle }, .created = opened.created };
}

pub fn createDir(zio: std.Io, parent: std.Io.Dir, name: []const u8) !void {
    const opened = try open(zio, parent, name, true, .CREATE);
    windows.CloseHandle(opened.handle);
}

fn reopen(handle: windows.HANDLE, directory: bool) !windows.HANDLE {
    const attributes: windows.OBJECT.ATTRIBUTES = .{
        .RootDirectory = handle,
        .ObjectName = @constCast(&windows.UNICODE_STRING.empty),
    };
    var result: windows.HANDLE = undefined;
    var iosb: windows.IO_STATUS_BLOCK = undefined;
    const status = windows.ntdll.NtCreateFile(&result, .{
        .GENERIC = .{ .READ = true, .WRITE = true },
        .STANDARD = .{ .SYNCHRONIZE = true, .RIGHTS = .{ .READ_CONTROL = true, .WRITE_DAC = true } },
    }, &attributes, &iosb, null, .{ .NORMAL = true }, .VALID_FLAGS, .OPEN, .{
        .DIRECTORY_FILE = directory,
        .NON_DIRECTORY_FILE = !directory,
        .IO = .SYNCHRONOUS_NONALERT,
        .OPEN_REPARSE_POINT = true,
    }, null, 0);
    if (status != .SUCCESS) return error.PrivateStatePermissionsUnsupported;
    return result;
}

pub fn makePrivate(handle: windows.HANDLE, directory: bool) !void {
    var info: c.BY_HANDLE_FILE_INFORMATION = undefined;
    if (c.GetFileInformationByHandle(handle, &info) == 0) return error.PrivateStatePermissionsUnsupported;
    if (info.dwFileAttributes & c.FILE_ATTRIBUTE_REPARSE_POINT != 0 or
        (info.dwFileAttributes & c.FILE_ATTRIBUTE_DIRECTORY != 0) != directory or
        (!directory and info.nNumberOfLinks != 1)) return error.DurablePathUnsafe;
    const reopened = try reopen(handle, directory);
    defer windows.CloseHandle(reopened);
    try protect(reopened, directory);
}

pub fn openDir(zio: std.Io, parent: std.Io.Dir, name: []const u8) !std.Io.Dir {
    const opened = try open(zio, parent, name, true, .OPEN);
    return .{ .handle = opened.handle };
}

pub fn createFile(zio: std.Io, parent: std.Io.Dir, name: []const u8, exclusive: bool) !std.Io.File {
    const opened = try open(zio, parent, name, false, if (exclusive) .CREATE else .OPEN_IF);
    return .{ .handle = opened.handle, .flags = .{ .nonblocking = false } };
}

pub fn syncDirectory(dir: std.Io.Dir) !void {
    const writable = try reopen(dir.handle, true);
    defer windows.CloseHandle(writable);
    if (c.FlushFileBuffers(writable) == 0) return error.OperationUnsupported;
}

/// Read-only admission check. Actual mutations must still handle access denial
/// because permissions can change between checking and opening the target.
pub fn canWrite(handle: windows.HANDLE, directory: bool) !bool {
    var descriptor: c.PSECURITY_DESCRIPTOR = null;
    if (c.GetSecurityInfo(handle, c.SE_FILE_OBJECT, c.OWNER_SECURITY_INFORMATION | c.GROUP_SECURITY_INFORMATION | c.DACL_SECURITY_INFORMATION, null, null, null, null, &descriptor) != c.ERROR_SUCCESS) return error.PrivateStatePermissionsUnsupported;
    defer _ = c.LocalFree(descriptor);
    var token: c.HANDLE = null;
    if (c.OpenProcessToken(c.GetCurrentProcess(), c.TOKEN_QUERY | c.TOKEN_DUPLICATE, &token) == 0) return error.PrivateStatePermissionsUnsupported;
    defer _ = c.CloseHandle(token);
    var impersonation: c.HANDLE = null;
    if (c.DuplicateToken(token, c.SecurityImpersonation, &impersonation) == 0) return error.PrivateStatePermissionsUnsupported;
    defer _ = c.CloseHandle(impersonation);
    var mapping: c.GENERIC_MAPPING = .{
        .GenericRead = c.FILE_GENERIC_READ,
        .GenericWrite = c.FILE_GENERIC_WRITE,
        .GenericExecute = c.FILE_GENERIC_EXECUTE,
        .GenericAll = c.FILE_ALL_ACCESS,
    };
    var privileges: [1024]u8 align(@alignOf(c.PRIVILEGE_SET)) = undefined;
    var size: u32 = privileges.len;
    var granted: u32 = 0;
    var allowed: c.BOOL = 0;
    const desired: u32 = if (directory) c.FILE_ADD_FILE | c.FILE_ADD_SUBDIRECTORY else c.FILE_WRITE_DATA;
    if (c.AccessCheck(descriptor, impersonation, desired, &mapping, @ptrCast(&privileges), &size, &granted, &allowed) == 0)
        return error.PrivateStatePermissionsUnsupported;
    return allowed != 0;
}

test "Windows private storage rejects traversal and alternate data streams" {
    for ([_][]const u8{ "", ".", "..", "a/b", "a\\b", "auth.json:secret", "a\x00b" }) |name|
        try std.testing.expectError(error.DurablePathUnsafe, validateLeaf(name));
    try validateLeaf("auth.json.tmp.123");
    try validateLeaf("日本語");
}

test "Windows private storage creates protected ACLs and rejects an unrestricted DACL" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const opened = try openOrCreateDir(std.testing.io, tmp.dir, "private");
    defer opened.dir.close(std.testing.io);
    try std.testing.expect(opened.created);
    try verify(opened.dir.handle, true);
    try std.testing.expect(try canWrite(opened.dir.handle, true));
    const reopened = try openOrCreateDir(std.testing.io, tmp.dir, "private");
    defer reopened.dir.close(std.testing.io);
    try std.testing.expect(!reopened.created);
    const file = try createFile(std.testing.io, opened.dir, "日本語.json", true);
    defer file.close(std.testing.io);
    try verify(file.handle, false);
    try std.testing.expect(try canWrite(file.handle, false));
    try file.writeStreamingAll(std.testing.io, "synthetic fixture");
    try file.sync(std.testing.io);
    try std.testing.expectError(error.PathAlreadyExists, createFile(std.testing.io, opened.dir, "日本語.json", true));
    if (c.SetSecurityInfo(file.handle, c.SE_FILE_OBJECT, c.DACL_SECURITY_INFORMATION | c.PROTECTED_DACL_SECURITY_INFORMATION, null, null, null, null) != c.ERROR_SUCCESS) return error.PrivateStatePermissionsUnsupported;
    try std.testing.expectError(error.PrivateStatePermissionsUnsupported, verify(file.handle, false));
    try protect(file.handle, false);
    try verify(file.handle, false);
    var broad: Security = undefined;
    try broad.init(false);
    var everyone: Sid = .{};
    var sid_length: u32 = everyone.bytes.len;
    if (c.CreateWellKnownSid(c.WinWorldSid, null, everyone.ptr(), &sid_length) == 0 or
        c.AddAccessAllowedAceEx(broad.acl(), c.ACL_REVISION, 0, c.FILE_GENERIC_READ, everyone.ptr()) == 0)
        return error.PrivateStatePermissionsUnsupported;
    if (c.SetSecurityInfo(file.handle, c.SE_FILE_OBJECT, c.DACL_SECURITY_INFORMATION | c.PROTECTED_DACL_SECURITY_INFORMATION, null, null, broad.acl(), null) != c.ERROR_SUCCESS) return error.PrivateStatePermissionsUnsupported;
    try std.testing.expectError(error.PrivateStatePermissionsUnsupported, verify(file.handle, false));
    try protect(file.handle, false);
    try opened.dir.hardLink("日本語.json", opened.dir, "linked.json", std.testing.io, .{});
    try std.testing.expectError(error.DurablePathUnsafe, verify(file.handle, false));
    try std.testing.expectError(error.DurablePathUnsafe, createFile(std.testing.io, opened.dir, "linked.json", false));
}

test "Windows private directory flush and ACL repair retain the open object" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const opened = try openOrCreateDir(std.testing.io, tmp.dir, "original");
    defer opened.dir.close(std.testing.io);
    try tmp.dir.rename("original", tmp.dir, "renamed", std.testing.io);
    try makePrivate(opened.dir.handle, true);
    try syncDirectory(opened.dir);
    const file = try createFile(std.testing.io, opened.dir, "fixture", true);
    defer file.close(std.testing.io);
    try opened.dir.rename("fixture", opened.dir, "renamed-file", std.testing.io);
    try makePrivate(file.handle, false);
    try verify(file.handle, false);
}
