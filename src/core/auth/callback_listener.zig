//! Loopback OAuth listeners need TIME_WAIT reuse without SO_REUSEPORT.
const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");

pub fn listen(address: std.Io.net.IpAddress) !std.Io.net.Server {
    // Windows has different reuse semantics. Keep its exclusive default.
    if (comptime builtin.os.tag == .windows) return address.listen(io_mod.getIo(), .{});
    const posix = std.posix;
    const SocketAddress = extern union {
        any: posix.sockaddr,
        ip4: posix.sockaddr.in,
        ip6: posix.sockaddr.in6,
    };
    var native: SocketAddress = undefined;
    const family: posix.sa_family_t = switch (address) {
        .ip4 => |ip| blk: {
            native.ip4 = .{ .port = std.mem.nativeToBig(u16, ip.port), .addr = @bitCast(ip.bytes) };
            break :blk posix.AF.INET;
        },
        .ip6 => |ip| blk: {
            native.ip6 = .{ .port = std.mem.nativeToBig(u16, ip.port), .flowinfo = ip.flow, .addr = ip.bytes, .scope_id = ip.interface.index };
            break :blk posix.AF.INET6;
        },
    };
    const needs_cloexec = comptime builtin.os.tag.isDarwin() or builtin.os.tag == .haiku;
    const flags = posix.SOCK.STREAM | (if (needs_cloexec) 0 else posix.SOCK.CLOEXEC);
    const fd = while (true) {
        const rc = posix.system.socket(family, flags, 0);
        switch (posix.errno(rc)) {
            .SUCCESS => break @as(posix.socket_t, @intCast(rc)),
            .INTR => continue,
            .AFNOSUPPORT => return error.AddressFamilyUnsupported,
            else => |err| return posix.unexpectedErrno(err),
        }
    };
    var socket: std.Io.net.Socket = .{ .handle = fd, .address = address };
    errdefer socket.close(io_mod.getIo());
    if (comptime needs_cloexec) {
        while (true) switch (posix.errno(posix.system.fcntl(fd, posix.F.SETFD, @as(usize, posix.FD_CLOEXEC)))) {
            .SUCCESS => break,
            .INTR => continue,
            else => |err| return posix.unexpectedErrno(err),
        };
    }
    // std.Io.net.listen's reuse_address also enables SO_REUSEPORT on POSIX.
    // Set only SO_REUSEADDR, before bind, so live listeners remain exclusive.
    const enabled: u32 = 1;
    const bytes = std.mem.asBytes(&enabled);
    while (true) switch (posix.errno(posix.system.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEADDR, bytes.ptr, @intCast(bytes.len)))) {
        .SUCCESS => break,
        .INTR => continue,
        else => |err| return posix.unexpectedErrno(err),
    };
    const address_len: posix.socklen_t = switch (address) {
        .ip4 => @sizeOf(posix.sockaddr.in),
        .ip6 => @sizeOf(posix.sockaddr.in6),
    };
    while (true) switch (posix.errno(posix.system.bind(fd, &native.any, address_len))) {
        .SUCCESS => break,
        .INTR => continue,
        .ADDRINUSE => return error.AddressInUse,
        .ADDRNOTAVAIL => return error.AddressUnavailable,
        .AFNOSUPPORT => return error.AddressFamilyUnsupported,
        else => |err| return posix.unexpectedErrno(err),
    };
    while (true) switch (posix.errno(posix.system.listen(fd, std.Io.net.default_kernel_backlog))) {
        .SUCCESS => break,
        .INTR => continue,
        .ADDRINUSE => return error.AddressInUse,
        else => |err| return posix.unexpectedErrno(err),
    };
    // Ephemeral test listeners must report the port selected by the kernel.
    var bound_len = address_len;
    while (true) switch (posix.errno(posix.system.getsockname(fd, &native.any, &bound_len))) {
        .SUCCESS => break,
        .INTR => continue,
        else => |err| return posix.unexpectedErrno(err),
    };
    socket.address.setPort(std.mem.bigToNative(u16, switch (address) {
        .ip4 => native.ip4.port,
        .ip6 => native.ip6.port,
    }));
    return .{
        .socket = socket,
        .options = if (std.Io.net.Server.AcceptOptions != void) .{ .mode = .stream, .protocol = .tcp },
    };
}
