//! Windows clipboard access. Borrowed system handles stay inside the open
//! clipboard scope; callers receive owned UTF-8 text or PNG bytes.
const std = @import("std");
const builtin = @import("builtin");
const raster = @import("../images/raster.zig");
const png = @import("../images/codec/png.zig");
const c = if (builtin.os.tag == .windows) @cImport({
    @cDefine("_FORTIFY_SOURCE", "0");
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    // Handles are opaque tokens, not aligned pointers to the header's dummy structs.
    @cDefine("NO_STRICT", "1");
    @cInclude("windows.h");
}) else struct {};

const ClipboardOwner = if (builtin.os.tag == .windows) c.HWND else ?*anyopaque;

fn open(owner: ClipboardOwner) !void {
    // Clipboard owners briefly hold an exclusive lock while publishing data.
    for (0..5) |attempt| {
        if (c.OpenClipboard(owner) != 0) return;
        if (attempt < 4) c.Sleep(10);
    }
    return error.ClipboardBusy;
}

pub fn loadText(alloc: std.mem.Allocator, limit: usize) ![]u8 {
    try open(null);
    defer _ = c.CloseClipboard();
    if (c.IsClipboardFormatAvailable(c.CF_UNICODETEXT) == 0) return alloc.dupe(u8, "");
    const handle = c.GetClipboardData(c.CF_UNICODETEXT) orelse return error.ClipboardReadFailed;
    const size = c.GlobalSize(handle);
    if (size == 0 or size % 2 != 0) return error.InvalidClipboardData;
    // A UTF-8 byte limit also bounds how many UTF-16 units need inspecting.
    const ptr: [*]const u16 = @ptrCast(@alignCast(c.GlobalLock(handle) orelse return error.ClipboardReadFailed));
    defer _ = c.GlobalUnlock(handle);
    return decodeText(alloc, ptr[0..@min(size / 2, limit +| 1)], limit);
}

fn decodeText(alloc: std.mem.Allocator, units: []const u16, limit: usize) ![]u8 {
    const end = std.mem.indexOfScalar(u16, units, 0) orelse return error.StreamTooLong;
    const text = try std.unicode.utf16LeToUtf8Alloc(alloc, units[0..end]);
    errdefer alloc.free(text);
    if (text.len > limit) return error.StreamTooLong;
    return text;
}

pub fn copyText(alloc: std.mem.Allocator, text: []const u8) !void {
    if (std.mem.indexOfScalar(u8, text, 0) != null) return error.InvalidClipboardData;
    const wide = try std.unicode.utf8ToUtf16LeAllocZ(alloc, text);
    defer alloc.free(wide);
    // SetClipboardData requires an owner window after EmptyClipboard. A
    // hidden STATIC window also works in terminals without a console HWND.
    const owner = c.CreateWindowExW(0, std.unicode.utf8ToUtf16LeStringLiteral("STATIC"), null, 0, 0, 0, 0, 0, null, null, null, null) orelse return error.ClipboardWriteFailed;
    defer _ = c.DestroyWindow(owner);
    const memory = c.GlobalAlloc(c.GMEM_MOVEABLE, (wide.len + 1) * 2) orelse return error.OutOfMemory;
    var transferred = false;
    defer if (!transferred) {
        _ = c.GlobalFree(memory);
    };
    const dest: [*]u16 = @ptrCast(@alignCast(c.GlobalLock(memory) orelse return error.ClipboardWriteFailed));
    @memcpy(dest[0 .. wide.len + 1], wide[0 .. wide.len + 1]);
    _ = c.GlobalUnlock(memory);
    try open(owner);
    defer _ = c.CloseClipboard();
    if (c.EmptyClipboard() == 0 or c.SetClipboardData(c.CF_UNICODETEXT, memory) == null) return error.ClipboardWriteFailed;
    transferred = true;
}

pub fn loadImagePng(alloc: std.mem.Allocator, limit: usize) ![]u8 {
    var image = blk: {
        try open(null);
        defer _ = c.CloseClipboard();
        const format = c.RegisterClipboardFormatW(std.unicode.utf8ToUtf16LeStringLiteral("PNG"));
        if (format == 0) return error.ClipboardReadFailed;
        if (c.IsClipboardFormatAvailable(format) != 0) {
            const handle = c.GetClipboardData(format) orelse return error.ClipboardReadFailed;
            const size = c.GlobalSize(handle);
            if (size == 0) return error.InvalidClipboardData;
            if (size > limit) return error.ImageTooLarge;
            const ptr: [*]const u8 = @ptrCast(c.GlobalLock(handle) orelse return error.ClipboardReadFailed);
            defer _ = c.GlobalUnlock(handle);
            return alloc.dupe(u8, ptr[0..size]);
        }
        // Windows synthesizes CF_BITMAP for DIB/DIBV5 sources, including
        // screenshots. Request top-down 32-bit pixels to avoid row padding.
        if (c.IsClipboardFormatAvailable(c.CF_BITMAP) == 0) return error.NoClipboardImage;
        const bitmap = c.GetClipboardData(c.CF_BITMAP) orelse return error.ClipboardReadFailed;
        var object: c.BITMAP = undefined;
        if (c.GetObjectW(bitmap, @sizeOf(c.BITMAP), &object) == 0) return error.ClipboardReadFailed;
        if (object.bmWidth <= 0 or object.bmHeight <= 0) return error.InvalidClipboardData;
        const width: u32 = @intCast(object.bmWidth);
        const height: u32 = @intCast(object.bmHeight);
        try raster.Limits.default.check(width, height);
        var pixels = try raster.Raster.init(alloc, width, height);
        errdefer pixels.deinit(alloc);
        var info = std.mem.zeroes(c.BITMAPINFO);
        info.bmiHeader.biSize = @sizeOf(c.BITMAPINFOHEADER);
        info.bmiHeader.biWidth = object.bmWidth;
        info.bmiHeader.biHeight = -object.bmHeight;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = c.BI_RGB;
        const dc = c.GetDC(null) orelse return error.ClipboardReadFailed;
        defer _ = c.ReleaseDC(null, dc);
        if (c.GetDIBits(dc, bitmap, 0, height, pixels.pixels.ptr, &info, c.DIB_RGB_COLORS) != height) return error.ClipboardReadFailed;
        opaqueBgraToRgba(pixels.pixels);
        break :blk pixels;
    };
    defer image.deinit(alloc);
    // Release the clipboard before PNG compression and snapshot I/O.
    const bytes = try png.encode(alloc, image);
    errdefer alloc.free(bytes);
    if (bytes.len > limit) return error.ImageTooLarge;
    return bytes;
}

fn opaqueBgraToRgba(pixels: []u8) void {
    var i: usize = 0;
    while (i < pixels.len) : (i += 4) {
        std.mem.swap(u8, &pixels[i], &pixels[i + 2]);
        // BI_RGB's fourth byte is reserved, not an alpha channel.
        pixels[i + 3] = 255;
    }
}

test "Windows clipboard text preserves Unicode and enforces UTF-8 byte limits" {
    const alloc = std.testing.allocator;
    const units = std.unicode.utf8ToUtf16LeStringLiteral("日本語 😀\r\n");
    const text = try decodeText(alloc, units[0 .. units.len + 1], 64);
    defer alloc.free(text);
    try std.testing.expectEqualStrings("日本語 😀\r\n", text);
    try std.testing.expectError(error.StreamTooLong, decodeText(alloc, units[0 .. units.len + 1], 3));
    try std.testing.expectError(error.StreamTooLong, decodeText(alloc, &.{65}, 64));
    try std.testing.expectError(error.DanglingSurrogateHalf, decodeText(alloc, &.{ 0xd800, 0 }, 64));
}

test "Windows clipboard bitmap conversion preserves colors and makes reserved alpha opaque" {
    var pixels = [_]u8{ 1, 2, 3, 0, 4, 5, 6, 128 };
    opaqueBgraToRgba(&pixels);
    try std.testing.expectEqualSlices(u8, &.{ 3, 2, 1, 255, 6, 5, 4, 255 }, &pixels);
}

// Opt in only on a disposable Windows desktop: these integration checks replace
// the system clipboard. Normal local test runs leave personal clipboard data alone.
test "Windows clipboard native Unicode PNG and bitmap round trips" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    var enabled: [2]u16 = undefined;
    if (c.GetEnvironmentVariableW(std.unicode.utf8ToUtf16LeStringLiteral("HANDWORK_TEST_CLIPBOARD"), &enabled, enabled.len) != 1 or enabled[0] != '1') return error.SkipZigTest;
    const alloc = std.testing.allocator;
    try copyText(alloc, "日本語 😀\r\n");
    const text = try loadText(alloc, 64);
    defer alloc.free(text);
    try std.testing.expectEqualStrings("日本語 😀\r\n", text);
    try std.testing.expectError(error.StreamTooLong, loadText(alloc, 3));
    try std.testing.expectError(error.NoClipboardImage, loadImagePng(alloc, 1024));

    const owner = c.CreateWindowExW(0, std.unicode.utf8ToUtf16LeStringLiteral("STATIC"), null, 0, 0, 0, 0, 0, null, null, null, null) orelse return error.ClipboardWriteFailed;
    defer _ = c.DestroyWindow(owner);
    var image = try raster.Raster.init(alloc, 1, 2);
    defer image.deinit(alloc);
    @memcpy(image.pixels, &[_]u8{ 10, 20, 30, 128, 40, 50, 60, 255 });
    const expected = try png.encode(alloc, image);
    defer alloc.free(expected);
    const format = c.RegisterClipboardFormatW(std.unicode.utf8ToUtf16LeStringLiteral("PNG"));
    const memory = c.GlobalAlloc(c.GMEM_MOVEABLE, expected.len) orelse return error.OutOfMemory;
    var owns_memory = true;
    defer if (owns_memory) {
        _ = c.GlobalFree(memory);
    };
    const dest: [*]u8 = @ptrCast(c.GlobalLock(memory) orelse return error.ClipboardWriteFailed);
    @memcpy(dest[0..expected.len], expected);
    _ = c.GlobalUnlock(memory);
    {
        try open(owner);
        defer _ = c.CloseClipboard();
        if (c.EmptyClipboard() == 0 or c.SetClipboardData(format, memory) == null) return error.ClipboardWriteFailed;
        owns_memory = false;
    }
    const actual = try loadImagePng(alloc, 1024);
    defer alloc.free(actual);
    // GlobalAlloc can round up its allocation, so compare the PNG prefix.
    try std.testing.expect(actual.len >= expected.len);
    try std.testing.expectEqualSlices(u8, expected, actual[0..expected.len]);
    try std.testing.expectError(error.ImageTooLarge, loadImagePng(alloc, 1));

    var info = std.mem.zeroes(c.BITMAPINFO);
    info.bmiHeader.biSize = @sizeOf(c.BITMAPINFOHEADER);
    info.bmiHeader.biWidth = 1;
    info.bmiHeader.biHeight = -2;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    var bits: ?*anyopaque = null;
    const bitmap = c.CreateDIBSection(null, &info, c.DIB_RGB_COLORS, &bits, null, 0) orelse return error.ClipboardWriteFailed;
    var owns_bitmap = true;
    defer if (owns_bitmap) {
        _ = c.DeleteObject(bitmap);
    };
    const bitmap_bytes: [*]u8 = @ptrCast(bits.?);
    @memcpy(bitmap_bytes[0..8], &[_]u8{ 30, 20, 10, 0, 60, 50, 40, 0 });
    {
        try open(owner);
        defer _ = c.CloseClipboard();
        if (c.EmptyClipboard() == 0 or c.SetClipboardData(c.CF_BITMAP, bitmap) == null) return error.ClipboardWriteFailed;
        owns_bitmap = false;
    }
    const converted = try loadImagePng(alloc, 1024);
    defer alloc.free(converted);
    var decoded = try png.decode(alloc, converted, .default);
    defer decoded.deinit(alloc);
    try std.testing.expectEqual(@as(u32, 1), decoded.width);
    try std.testing.expectEqual(@as(u32, 2), decoded.height);
    try std.testing.expectEqualSlices(u8, &.{ 10, 20, 30, 255, 40, 50, 60, 255 }, decoded.pixels);
    // Clear our fixture while its owner window still exists.
    try open(owner);
    defer _ = c.CloseClipboard();
    if (c.EmptyClipboard() == 0) return error.ClipboardWriteFailed;
}
