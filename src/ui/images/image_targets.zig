//! Resolves Markdown image destinations to image sources.
//!
//! Local files and `data:` URIs render without network access. Remote
//! `http(s)` images are fetched only when HANDWORK_REMOTE_IMAGES=1: a model
//! can be steered (for example by prompt injection in a fetched page) into
//! emitting an image URL that carries conversation data, and loading it
//! would send that data to a third party. Fetches use the web tool's
//! public-address pinning, size cap, and deadline, never follow cross-host
//! redirects, and are cached for the session so each URL is requested once.

const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../../core/shared/io.zig");
const debug_trace = @import("../../core/shared/debug_trace.zig");
const inline_images = @import("inline_images.zig");

const Allocator = std.mem.Allocator;

const max_remote_bytes: usize = 10 * 1024 * 1024;
const remote_deadline_ms: i64 = 5_000;
const max_data_uri_bytes: usize = 8 * 1024 * 1024;

pub const Target = union(enum) {
    /// Owned absolute path.
    file: []u8,
    /// Owned encoded image bytes (from a data URI or a remote fetch).
    bytes: []u8,

    pub fn deinit(self: *Target, alloc: Allocator) void {
        switch (self.*) {
            inline else => |owned| alloc.free(owned),
        }
        self.* = undefined;
    }

    pub fn source(self: Target) inline_images.Source {
        return switch (self) {
            .file => |path| .{ .file = path },
            .bytes => |bytes| .{ .encoded = bytes },
        };
    }
};

pub fn remoteImagesEnabled() bool {
    const value = io_mod.getenv("HANDWORK_REMOTE_IMAGES") orelse return false;
    return std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true") or std.ascii.eqlIgnoreCase(value, "on");
}

/// Resolves `target` against `base_dir`. Returns null for destinations
/// that cannot be shown (unsupported scheme, disabled remote images,
/// failed fetch).
pub fn resolve(alloc: Allocator, target: []const u8, base_dir: []const u8) !?Target {
    if (startsWithIgnoreCase(target, "data:")) {
        const bytes = decodeDataUri(alloc, target) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return null,
        };
        return .{ .bytes = bytes };
    }
    if (startsWithIgnoreCase(target, "http://") or startsWithIgnoreCase(target, "https://")) {
        if (!remoteImagesEnabled()) return null;
        const bytes = try remote_cache.get(alloc, target) orelse return null;
        return .{ .bytes = bytes };
    }
    if (startsWithIgnoreCase(target, "file://")) {
        const decoded_path = percentDecode(alloc, target["file://".len..]) catch return null;
        defer alloc.free(decoded_path);
        // Windows file URLs put a slash before the drive letter.
        const path = if (builtin.os.tag == .windows and decoded_path.len >= 4 and
            decoded_path[0] == '/' and std.ascii.isAlphabetic(decoded_path[1]) and decoded_path[2] == ':')
            decoded_path[1..]
        else
            decoded_path;
        if (!std.fs.path.isAbsolute(path)) return null;
        return .{ .file = try alloc.dupe(u8, path) };
    }
    if (std.mem.indexOf(u8, target, "://") != null or startsWithIgnoreCase(target, "mailto:")) return null;

    const decoded = percentDecode(alloc, target) catch return null;
    defer alloc.free(decoded);
    if (std.mem.startsWith(u8, decoded, "~/")) {
        const home = io_mod.getenv("HOME") orelse io_mod.getenv("USERPROFILE") orelse return null;
        return .{ .file = try std.fs.path.join(alloc, &.{ home, decoded[2..] }) };
    }
    if (std.fs.path.isAbsolute(decoded)) return .{ .file = try alloc.dupe(u8, decoded) };
    return .{ .file = try std.fs.path.resolve(alloc, &.{ base_dir, decoded }) };
}

var workspace_dir: ?[]u8 = null;
var workspace_dir_once: std.Io.Mutex = .init;

/// Directory relative image paths resolve against: the process working
/// directory, which Handwork sets to the workspace root at launch.
pub fn workspaceDir() ?[]const u8 {
    workspace_dir_once.lockUncancelable(io_mod.getIo());
    defer workspace_dir_once.unlock(io_mod.getIo());
    if (workspace_dir == null) {
        workspace_dir = std.process.currentPathAlloc(io_mod.getIo(), std.heap.c_allocator) catch return null;
    }
    return workspace_dir;
}

/// Admission policy installed into the Markdown processor: an image-only
/// paragraph becomes an image block only if its destination decodes now.
pub fn admitStandaloneImage(target: []const u8) bool {
    if (inline_images.active() == null) return false;
    const alloc = std.heap.c_allocator;
    const base = workspaceDir() orelse return false;
    var resolved = (resolve(alloc, target, base) catch return false) orelse return false;
    defer resolved.deinit(alloc);
    return inline_images.canRender(resolved.source());
}

fn startsWithIgnoreCase(text: []const u8, prefix: []const u8) bool {
    return text.len >= prefix.len and std.ascii.eqlIgnoreCase(text[0..prefix.len], prefix);
}

fn decodeDataUri(alloc: Allocator, uri: []const u8) ![]u8 {
    const comma = std.mem.indexOfScalar(u8, uri, ',') orelse return error.InvalidDataUri;
    const meta = uri["data:".len..comma];
    const data = uri[comma + 1 ..];
    if (!startsWithIgnoreCase(meta, "image/")) return error.InvalidDataUri;
    if (!std.mem.endsWith(u8, meta, ";base64")) {
        if (data.len > max_data_uri_bytes * 3) return error.InvalidDataUri;
        const bytes = try percentDecode(alloc, data);
        errdefer alloc.free(bytes);
        if (bytes.len > max_data_uri_bytes) return error.InvalidDataUri;
        return bytes;
    }
    const decoder = std.base64.standard.Decoder;
    const trimmed = std.mem.trim(u8, data, " \t\r\n");
    const size = decoder.calcSizeForSlice(trimmed) catch return error.InvalidDataUri;
    if (size > max_data_uri_bytes) return error.InvalidDataUri;
    const bytes = try alloc.alloc(u8, size);
    errdefer alloc.free(bytes);
    decoder.decode(bytes, trimmed) catch return error.InvalidDataUri;
    return bytes;
}

fn percentDecode(alloc: Allocator, text: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] == '%' and i + 2 < text.len) {
            const value = std.fmt.parseInt(u8, text[i + 1 .. i + 3], 16) catch {
                try out.append(alloc, text[i]);
                continue;
            };
            try out.append(alloc, value);
            i += 2;
        } else {
            try out.append(alloc, text[i]);
        }
    }
    return out.toOwnedSlice(alloc);
}

const RemoteCache = struct {
    mutex: std.Io.Mutex = .init,
    /// url -> fetched bytes, or null when the fetch failed.
    entries: std.StringHashMapUnmanaged(?[]u8) = .empty,

    /// Returns a caller-owned copy of the image bytes at `url`.
    fn get(self: *RemoteCache, alloc: Allocator, url: []const u8) !?[]u8 {
        const gpa = std.heap.c_allocator;
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        const cached = self.entries.get(url) orelse blk: {
            const fetched = fetchImage(gpa, url) catch |err| fail: {
                debug_trace.logf("images", "remote_fetch_failed err={s}", .{@errorName(err)});
                break :fail null;
            };
            errdefer if (fetched) |bytes| gpa.free(bytes);
            const key = try gpa.dupe(u8, url);
            errdefer gpa.free(key);
            try self.entries.put(gpa, key, fetched);
            break :blk fetched;
        };
        const bytes = cached orelse return null;
        return try alloc.dupe(u8, bytes);
    }
};

var remote_cache: RemoteCache = .{};

fn fetchImage(alloc: Allocator, url: []const u8) ![]u8 {
    // WASI hosts have no sockets; the import stays out of that build.
    if (comptime builtin.os.tag == .wasi) return error.RemoteImageUnavailable;
    const url_policy = @import("../../tools/web/url_policy.zig");
    const http_fetch = @import("../../tools/web/http_fetch.zig");
    var validated = try url_policy.normalize(alloc, url);
    defer validated.deinit(alloc);
    var result = try http_fetch.fetch(alloc, validated, .{
        .max_body_bytes = max_remote_bytes,
        .deadline = .{ .deadline_ms = io_mod.milliTimestamp() + remote_deadline_ms },
    }, http_fetch.defaultTransport());
    defer result.deinit(alloc);
    switch (result) {
        .success => |*success| {
            const body = success.body;
            success.body = &.{};
            return body;
        },
        .failure, .cross_host_redirect => return error.RemoteImageUnavailable,
    }
}

test "resolves relative, absolute, home, and file URL paths" {
    const alloc = std.testing.allocator;
    const base = if (builtin.os.tag == .windows) "C:\\work\\project" else "/work/project";
    var relative = (try resolve(alloc, "out/plot%20one.png", base)).?;
    defer relative.deinit(alloc);
    try std.testing.expectEqualStrings(if (builtin.os.tag == .windows) "C:\\work\\project\\out\\plot one.png" else "/work/project/out/plot one.png", relative.file);

    var parent = (try resolve(alloc, "../shared/a.png", base)).?;
    defer parent.deinit(alloc);
    try std.testing.expectEqualStrings(if (builtin.os.tag == .windows) "C:\\work\\shared\\a.png" else "/work/shared/a.png", parent.file);

    var absolute = (try resolve(alloc, if (builtin.os.tag == .windows) "file:///C:/tmp/a.png" else "file:///tmp/a.png", base)).?;
    defer absolute.deinit(alloc);
    try std.testing.expectEqualStrings(if (builtin.os.tag == .windows) "C:/tmp/a.png" else "/tmp/a.png", absolute.file);

    try std.testing.expectEqual(@as(?Target, null), try resolve(alloc, "ftp://example.com/a.png", "/work"));
    try std.testing.expectEqual(@as(?Target, null), try resolve(alloc, "file://relative/a.png", "/work"));
}

test "data URIs decode and remote URLs stay off unless enabled" {
    const alloc = std.testing.allocator;
    var data = (try resolve(alloc, "data:image/png;base64,iVBORw0KGgo=", "/")).?;
    defer data.deinit(alloc);
    try std.testing.expectEqualStrings("\x89PNG\r\n\x1a\n", data.bytes);
    try std.testing.expectEqual(@as(?Target, null), try resolve(alloc, "data:text/html;base64,PGI+", "/"));
    if (!remoteImagesEnabled()) {
        try std.testing.expectEqual(@as(?Target, null), try resolve(alloc, "https://example.com/a.png", "/"));
    }
}

test "percent-encoded data URIs enforce the decoded byte limit" {
    const alloc = std.testing.allocator;
    var data = (try resolve(alloc, "data:image/svg+xml,%3Csvg%2F%3E", "/")).?;
    defer data.deinit(alloc);
    try std.testing.expectEqualStrings("<svg/>", data.bytes);
    const prefix = "data:image/svg+xml,";
    const oversized = try alloc.alloc(u8, prefix.len + max_data_uri_bytes + 1);
    defer alloc.free(oversized);
    @memcpy(oversized[0..prefix.len], prefix);
    @memset(oversized[prefix.len..], 'x');
    try std.testing.expectError(error.InvalidDataUri, decodeDataUri(alloc, oversized));
}
