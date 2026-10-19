//! OAuth callback sockets use the same AFD handles as Zig 0.16 std.Io.net.
//! Winsock polling and socket options cannot be used on those raw handles.
const std = @import("std");
const builtin = @import("builtin");
const windows = std.os.windows;
const ws2_32 = windows.ws2_32;

fn control(io: std.Io, handle: windows.HANDLE, code: windows.CTL_CODE, input: []const u8, output: []u8) !windows.NTSTATUS {
    const result = try io.operate(.{ .device_io_control = .{
        .file = .{ .handle = handle, .flags = .{ .nonblocking = true } },
        .code = code,
        .in = input,
        .out = output,
    } });
    return result.device_io_control.u.Status;
}

pub fn listen(io: std.Io, address: std.Io.net.IpAddress) !std.Io.net.Server {
    var handle: windows.HANDLE = undefined;
    var iosb: windows.IO_STATUS_BLOCK = undefined;
    const status = windows.ntdll.NtCreateFile(
        &handle,
        .{
            .STANDARD = .{ .RIGHTS = .{ .WRITE_DAC = true }, .SYNCHRONIZE = true },
            .GENERIC = .{ .WRITE = true, .READ = true },
        },
        &.{ .ObjectName = @constCast(&windows.UNICODE_STRING.init(
            windows.AFD.DEVICE_NAME ++ .{ '\\', 'E', 'n', 'd', 'p', 'o', 'i', 'n', 't' },
        )) },
        &iosb,
        null,
        .{},
        .{ .READ = true, .WRITE = true },
        .OPEN_IF,
        .{ .IO = .ASYNCHRONOUS },
        &windows.AFD.OPEN_PACKET.FULL_EA_INFORMATION{ .Value = .{
            .EndpointType = .{},
            .GroupID = 0,
            .AddressFamily = switch (address) {
                .ip4 => ws2_32.AF.INET,
                .ip6 => ws2_32.AF.INET6,
            },
            .SocketType = ws2_32.SOCK.STREAM,
            .Protocol = ws2_32.IPPROTO.TCP,
            .TransportDeviceNameLength = 0,
            .TransportDeviceName = undefined,
        } },
        @sizeOf(windows.AFD.OPEN_PACKET.FULL_EA_INFORMATION),
    );
    switch (status) {
        .SUCCESS => {},
        .PROTOCOL_NOT_SUPPORTED => return error.AddressFamilyUnsupported,
        else => return windows.unexpectedStatus(status),
    }
    errdefer windows.CloseHandle(handle);

    const Storage = extern struct {
        info: windows.AFD.BIND_INFO,
        address: std.Io.Threaded.PosixAddress,
    };
    // AFD_EXCLUSIVEADDRUSE = 3. std.Io.net.listen uses Passive = 1,
    // which allows live listeners to share the callback address.
    var storage: Storage = .{ .info = .{ .Mode = @enumFromInt(3) }, .address = undefined };
    const address_len = std.Io.Threaded.addressToPosix(&address, &storage.address);
    switch (try control(io, handle, windows.IOCTL.AFD.BIND, std.mem.asBytes(&storage)[0 .. @offsetOf(Storage, "address") + address_len], std.mem.asBytes(&storage.address)[0..address_len])) {
        .SUCCESS => {},
        .SHARING_VIOLATION, .ACCESS_DENIED, .ADDRESS_ALREADY_EXISTS => return error.AddressInUse,
        .INVALID_ADDRESS, .INVALID_ADDRESS_COMPONENT => return error.AddressUnavailable,
        else => |err| return windows.unexpectedStatus(err),
    }
    const bound_address = std.Io.Threaded.addressFromPosix(&storage.address);
    const options: windows.AFD.LISTEN_INFO = .{
        .UseSAN = .FALSE,
        .MaximumConnectionQueue = std.Io.net.default_kernel_backlog,
        .UseDelayedAcceptance = .FALSE,
    };
    switch (try control(io, handle, windows.IOCTL.AFD.START_LISTEN, std.mem.asBytes(&options), &.{})) {
        .SUCCESS => {},
        else => |err| return windows.unexpectedStatus(err),
    }
    return .{ .socket = .{ .handle = handle, .address = bound_address }, .options = .{ .mode = .stream, .protocol = .tcp } };
}

fn pollTimedOut(status: windows.NTSTATUS) bool {
    // AFD can complete an expired poll with the I/O timeout status rather
    // than the wait timeout status. Neither indicates a broken listener.
    return status == .TIMEOUT or status == .IO_TIMEOUT;
}

pub fn readable(io: std.Io, handle: windows.HANDLE, timeout_ms: i32) !bool {
    const Entry = extern struct { handle: windows.HANDLE, events: u32, status: windows.NTSTATUS };
    const PollInfo = extern struct { timeout: i64, count: u32, exclusive: u32, entries: [1]Entry };
    // Receive, disconnect, abort, local close, accept. EOF must wake readers too.
    const events = 0x0001 | 0x0008 | 0x0010 | 0x0020 | 0x0080;
    var info: PollInfo = .{
        .timeout = -@as(i64, timeout_ms) * (std.time.ns_per_ms / 100),
        .count = 1,
        .exclusive = 0,
        .entries = .{.{ .handle = handle, .events = events, .status = .SUCCESS }},
    };
    const status = try control(io, handle, windows.IOCTL.AFD.POLL, std.mem.asBytes(&info), std.mem.asBytes(&info));
    if (pollTimedOut(status)) return false;
    if (status != .SUCCESS) {
        std.log.err("OAuth callback AFD poll failed status={s} (0x{x})", .{ @tagName(status), @intFromEnum(status) });
        return windows.unexpectedStatus(status);
    }
    if (info.count == 0) return false;
    // A reset is readable: the stream reader classifies it and drops the
    // speculative connection without terminating the login attempt.
    if (info.entries[0].status != .SUCCESS and info.entries[0].events & 0x0010 == 0) {
        std.log.err("OAuth callback AFD poll entry failed status={s} (0x{x}) events=0x{x}", .{
            @tagName(info.entries[0].status), @intFromEnum(info.entries[0].status), info.entries[0].events,
        });
        return windows.unexpectedStatus(info.entries[0].status);
    }
    if (info.entries[0].events & 0x0020 != 0) return error.OAuthCallbackListenerFailed;
    return info.entries[0].events & events != 0;
}

test "Windows callback AFD poll recognizes only native timeout statuses" {
    try std.testing.expect(pollTimedOut(.TIMEOUT));
    try std.testing.expect(pollTimedOut(.IO_TIMEOUT));
    try std.testing.expect(!pollTimedOut(.SUCCESS));
    try std.testing.expect(!pollTimedOut(.INVALID_HANDLE));
    try std.testing.expect(!pollTimedOut(.INVALID_PARAMETER));
}

test "Windows callback AFD sockets poll accept data silence EOF and reserve each loopback family" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const io = std.testing.io;
    for ([_][]const u8{ "127.0.0.1", "::1" }) |hostname| {
        const address = try std.Io.net.IpAddress.parse(hostname, 0);
        var server = listen(io, address) catch |err| switch (err) {
            error.AddressFamilyUnsupported, error.AddressUnavailable => if (address == .ip6) continue else return err,
            else => return err,
        };
        defer server.deinit(io);
        try std.testing.expectError(error.AddressInUse, listen(io, server.socket.address));
        // Also reject a listener requesting std.Io's shared bind mode.
        if (server.socket.address.listen(io, .{ .reuse_address = true })) |shared| {
            var unexpected = shared;
            unexpected.deinit(io);
            return error.SharedCallbackAddress;
        } else |_| {}
        try std.testing.expect(!try readable(io, server.socket.handle, 0));
        const client = try server.socket.address.connect(io, .{ .mode = .stream });
        defer client.close(io);
        try std.testing.expect(try readable(io, server.socket.handle, 1000));
        try std.testing.expect(try readable(io, server.socket.handle, 0));
        const peer = try server.accept(io);
        var peer_open = true;
        defer if (peer_open) peer.close(io);
        try std.testing.expect(!try readable(io, peer.socket.handle, 10));
        var writer = client.writer(io, &.{});
        try writer.interface.writeAll("callback");
        try writer.interface.flush();
        try std.testing.expect(try readable(io, peer.socket.handle, 1000));
        var reader = peer.reader(io, &.{});
        var buffer: [8]u8 = undefined;
        try reader.interface.readSliceAll(&buffer);
        try std.testing.expectEqualStrings("callback", &buffer);
        peer.close(io);
        peer_open = false;
        try std.testing.expect(try readable(io, client.socket.handle, 1000));
        var client_reader = client.reader(io, &.{});
        try std.testing.expectError(error.EndOfStream, client_reader.interface.takeByte());
    }
}
