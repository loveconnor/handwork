//! Nonblocking Winsock transport for the pinned-address HTTP fetcher.
const std = @import("std");
const builtin = @import("builtin");
const c = if (builtin.os.tag == .windows) @cImport({
    // Import API declarations only: Zig 0.16 cannot translate MinGW's
    // fortified wide-string inline wrappers in ReleaseSafe mode.
    @cDefine("_FORTIFY_SOURCE", "0");
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    @cInclude("winsock2.h");
    @cInclude("ws2tcpip.h");
}) else struct {};

pub const Handle = usize;
pub const PollFd = extern struct { fd: Handle, events: i16, revents: i16 };
pub const Poll = struct {
    pub const IN: i16 = 0x0100;
    pub const OUT: i16 = 0x0010;
    pub const ERR: i16 = 0x0001;
    pub const HUP: i16 = 0x0002;
    pub const NVAL: i16 = 0x0004;
};
pub const Result = union(enum) { count: usize, failure: std.posix.E };
pub const Connection = struct { handle: Handle, pending: bool };

pub fn errno(code: c_int) std.posix.E {
    return switch (code) {
        0 => .SUCCESS,
        10004 => .INTR,
        10009, 10038 => .BADF,
        10013 => .ACCES,
        10022 => .INVAL,
        10024 => .MFILE,
        10035 => .AGAIN,
        10036 => .INPROGRESS,
        10037 => .ALREADY,
        10047 => .AFNOSUPPORT,
        10050 => .NETDOWN,
        10051 => .NETUNREACH,
        10052, 10054 => .CONNRESET,
        10053 => .CONNABORTED,
        10055 => .NOBUFS,
        10057 => .NOTCONN,
        10058 => .PIPE,
        10060 => .TIMEDOUT,
        10061 => .CONNREFUSED,
        10065 => .HOSTUNREACH,
        else => .IO,
    };
}

pub fn connect(address: std.Io.net.IpAddress) !Connection {
    var data: c.WSADATA = undefined;
    if (c.WSAStartup(0x0202, &data) != 0) return error.NetworkDown;
    errdefer _ = c.WSACleanup();
    const family: c_int = switch (address) {
        .ip4 => c.AF_INET,
        .ip6 => c.AF_INET6,
    };
    const handle = c.WSASocketW(family, c.SOCK_STREAM, c.IPPROTO_TCP, null, 0, c.WSA_FLAG_NO_HANDLE_INHERIT);
    if (handle == c.INVALID_SOCKET) return error.SocketOpenFailed;
    errdefer _ = c.closesocket(handle);
    var nonblocking: c_ulong = 1;
    if (c.ioctlsocket(handle, @as(c_long, @bitCast(@as(u32, 0x8004667e))), &nonblocking) != 0) return error.SocketOptionFailed;
    const rc = switch (address) {
        .ip4 => |ip| blk: {
            var native = std.mem.zeroes(c.SOCKADDR_IN);
            native.sin_family = c.AF_INET;
            native.sin_port = std.mem.nativeToBig(u16, ip.port);
            @memcpy(std.mem.asBytes(&native.sin_addr), &ip.bytes);
            break :blk c.connect(handle, @ptrCast(&native), @sizeOf(c.SOCKADDR_IN));
        },
        .ip6 => |ip| blk: {
            var native = std.mem.zeroes(extern struct { sin6_family: u16, sin6_port: u16, sin6_flowinfo: u32, sin6_addr: [16]u8, sin6_scope_id: u32 });
            native.sin6_family = c.AF_INET6;
            native.sin6_port = std.mem.nativeToBig(u16, ip.port);
            native.sin6_flowinfo = ip.flow;
            native.sin6_scope_id = ip.interface.index;
            @memcpy(std.mem.asBytes(&native.sin6_addr), &ip.bytes);
            break :blk c.connect(handle, @ptrCast(&native), @sizeOf(@TypeOf(native)));
        },
    };
    if (rc == 0) return .{ .handle = handle, .pending = false };
    switch (errno(c.WSAGetLastError())) {
        .AGAIN, .INPROGRESS, .ALREADY => return .{ .handle = handle, .pending = true },
        .CONNREFUSED => return error.ConnectionRefused,
        .NETUNREACH => return error.NetworkUnreachable,
        .HOSTUNREACH => return error.HostUnreachable,
        .TIMEDOUT => return error.Timeout,
        else => return error.ConnectionFailed,
    }
}

pub fn close(handle: Handle) void {
    _ = c.closesocket(handle);
    _ = c.WSACleanup();
}

pub fn poll(fds: []PollFd, timeout_ms: i32) !usize {
    const rc = c.WSAPoll(@ptrCast(fds.ptr), @intCast(fds.len), timeout_ms);
    if (rc >= 0) return @intCast(rc);
    return switch (errno(c.WSAGetLastError())) {
        .INTR => error.Interrupted,
        .NETDOWN => error.NetworkDown,
        else => error.SystemResources,
    };
}

/// Nonblocking connect succeeds in writefds and fails in exceptfds. Ordinary
/// read/write polling is not the connect-completion contract on Winsock.
/// https://learn.microsoft.com/windows/win32/api/winsock2/nf-winsock2-select
pub fn waitForConnect(handle: Handle, timeout_ms: u32) !std.posix.E {
    var writable = std.mem.zeroes(c.fd_set);
    writable.fd_count = 1;
    writable.fd_array[0] = handle;
    var failed = writable;
    var timeout: c.timeval = .{
        .tv_sec = @intCast(timeout_ms / 1000),
        .tv_usec = @intCast((timeout_ms % 1000) * 1000),
    };
    const rc = c.select(0, null, &writable, &failed, &timeout);
    if (rc == 0) return error.Timeout;
    if (rc < 0) return switch (errno(c.WSAGetLastError())) {
        .INTR => error.Interrupted,
        else => error.ConnectionFailed,
    };
    return socketError(handle);
}

pub fn socketError(handle: Handle) !std.posix.E {
    var code: c_int = 0;
    var length: c_int = @sizeOf(c_int);
    if (c.getsockopt(handle, c.SOL_SOCKET, c.SO_ERROR, @ptrCast(&code), &length) != 0) return error.ConnectionFailed;
    return errno(code);
}

pub fn receive(handle: Handle, bytes: []u8) Result {
    const n = c.recv(handle, bytes.ptr, @intCast(@min(bytes.len, std.math.maxInt(c_int))), 0);
    return if (n < 0) .{ .failure = errno(c.WSAGetLastError()) } else .{ .count = @intCast(n) };
}

pub fn send(handle: Handle, bytes: []const u8) Result {
    const n = c.send(handle, bytes.ptr, @intCast(@min(bytes.len, std.math.maxInt(c_int))), 0);
    return if (n < 0) .{ .failure = errno(c.WSAGetLastError()) } else .{ .count = @intCast(n) };
}

pub fn setTimeouts(handle: Handle, seconds: i64) !void {
    const millis: u32 = @intCast(std.math.clamp(seconds *| 1000, 1, std.math.maxInt(u32)));
    try setTimeoutMillis(handle, millis);
}

pub fn setTimeoutMillis(handle: Handle, millis: u32) !void {
    for ([_]c_int{ c.SO_RCVTIMEO, c.SO_SNDTIMEO }) |option| {
        if (c.setsockopt(handle, c.SOL_SOCKET, option, @ptrCast(&millis), @sizeOf(u32)) != 0) return error.SocketOptionFailed;
    }
}

test "Windows socket error translation preserves retry, refusal, reset and timeout" {
    try std.testing.expectEqual(std.posix.E.AGAIN, errno(10035));
    try std.testing.expectEqual(std.posix.E.CONNREFUSED, errno(10061));
    try std.testing.expectEqual(std.posix.E.CONNRESET, errno(10054));
    try std.testing.expectEqual(std.posix.E.TIMEDOUT, errno(10060));
}

test "Windows socket connect completion reports refusal on both loopback families" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    for ([_][]const u8{ "127.0.0.1", "::1" }) |hostname| {
        const address = try std.Io.net.IpAddress.parse(hostname, 0);
        var server = address.listen(std.testing.io, .{}) catch |err| switch (err) {
            error.AddressFamilyUnsupported, error.AddressUnavailable => if (address == .ip6) continue else return err,
            else => return err,
        };
        const closed_address = server.socket.address;
        server.deinit(std.testing.io);
        const connection = connect(closed_address) catch |err| switch (err) {
            error.ConnectionRefused => continue,
            else => return err,
        };
        defer close(connection.handle);
        try std.testing.expect(connection.pending);
        try std.testing.expectEqual(std.posix.E.CONNREFUSED, try waitForConnect(connection.handle, 10_000));
    }
}

test "Windows socket loopback connects polls exchanges bytes and observes eof" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const address = std.Io.net.IpAddress{ .ip4 = .{ .bytes = .{ 127, 0, 0, 1 }, .port = 0 } };
    var server = try address.listen(std.testing.io, .{ .reuse_address = true });
    defer server.deinit(std.testing.io);
    const connection = try connect(server.socket.address);
    defer close(connection.handle);
    try std.testing.expectEqual(std.posix.E.SUCCESS, try waitForConnect(connection.handle, 2000));
    var writable = [_]PollFd{.{ .fd = connection.handle, .events = Poll.OUT, .revents = 0 }};
    try std.testing.expectEqual(@as(usize, 1), try poll(&writable, 2000));
    const peer = try server.accept(std.testing.io);
    var peer_open = true;
    defer if (peer_open) peer.close(std.testing.io);
    try setTimeoutMillis(connection.handle, 250);
    const payload = "Windows 日本語";
    try std.testing.expectEqual(payload.len, send(connection.handle, payload).count);
    var buffer: [128]u8 = undefined;
    var reader = peer.reader(std.testing.io, &.{});
    try reader.interface.readSliceAll(buffer[0..payload.len]);
    try std.testing.expectEqualStrings(payload, buffer[0..payload.len]);
    var writer = peer.writer(std.testing.io, &.{});
    try writer.interface.writeAll("reply");
    try writer.interface.flush();
    var readable = [_]PollFd{.{ .fd = connection.handle, .events = Poll.IN, .revents = 0 }};
    try std.testing.expectEqual(@as(usize, 1), try poll(&readable, 2000));
    const received = receive(connection.handle, &buffer).count;
    try std.testing.expectEqualStrings("reply", buffer[0..received]);
    try std.testing.expectEqual(@as(usize, 0), try poll(&readable, 0));
    peer.close(std.testing.io);
    peer_open = false;
    try std.testing.expectEqual(@as(usize, 1), try poll(&readable, 2000));
    try std.testing.expectEqual(@as(usize, 0), receive(connection.handle, &buffer).count);
}
