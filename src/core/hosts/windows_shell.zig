//! Open web URLs through the Windows shell without command-line interpretation.
const std = @import("std");
const builtin = @import("builtin");
const c = if (builtin.os.tag == .windows) @cImport({
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    @cInclude("windows.h");
    @cInclude("shellapi.h");
    @cInclude("objbase.h");
}) else struct {};

pub fn isWebUrl(url: []const u8) bool {
    if (std.mem.indexOfScalar(u8, url, 0) != null) return false;
    const parsed = std.Uri.parse(url) catch return false;
    return (std.ascii.eqlIgnoreCase(parsed.scheme, "https") or std.ascii.eqlIgnoreCase(parsed.scheme, "http")) and
        parsed.host != null and parsed.user == null and parsed.password == null;
}

pub fn openWebUrl(alloc: std.mem.Allocator, url: []const u8) std.mem.Allocator.Error!bool {
    if (!isWebUrl(url)) return false;
    const wide = std.unicode.utf8ToUtf16LeAllocZ(alloc, url) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return false,
    };
    defer alloc.free(wide);
    const initialized = c.CoInitializeEx(null, c.COINIT_APARTMENTTHREADED | c.COINIT_DISABLE_OLE1DDE);
    defer if (initialized >= 0) c.CoUninitialize();
    const result = c.ShellExecuteW(null, std.unicode.utf8ToUtf16LeStringLiteral("open"), wide.ptr, null, null, c.SW_SHOWNORMAL);
    return @intFromPtr(result) > 32;
}

test "Windows browser opening accepts web URLs and rejects executable protocols and embedded nul" {
    try std.testing.expect(isWebUrl("https://example.com/oauth?code=a&state=b"));
    try std.testing.expect(isWebUrl("http://127.0.0.1:1234/callback"));
    for ([_][]const u8{ "file:///C:/Windows/system32/cmd.exe", "javascript:alert(1)", "ms-settings:privacy", "https://x\x00.cmd", "https://user:secret@example.com" }) |url|
        try std.testing.expect(!isWebUrl(url));
}
