//! Kitty graphics protocol commands for virtual (Unicode placeholder)
//! placements. Reference: https://sw.kovidgoyal.net/kitty/graphics-protocol/

const std = @import("std");

/// Base64 payload bytes per escape. The protocol requires chunks of at
/// most 4096 bytes and every chunk except the last to be a multiple of 4.
const chunk_bytes: usize = 4096;

/// Transmits PNG bytes as image `image_id` and creates a virtual placement
/// of `cols` x `rows` cells that placeholder cells can display. `q=2`
/// suppresses replies so nothing is written back into the input stream.
pub fn writeTransmitPng(writer: *std.Io.Writer, image_id: u32, png: []const u8, cols: u16, rows: u16) !void {
    const encoder = std.base64.standard.Encoder;
    var encoded_buf: [chunk_bytes]u8 = undefined;
    // Each 4096-byte base64 chunk carries exactly 3072 source bytes.
    const source_chunk = chunk_bytes / 4 * 3;
    var offset: usize = 0;
    var first = true;
    while (true) {
        const end = @min(offset + source_chunk, png.len);
        const encoded = encoder.encode(&encoded_buf, png[offset..end]);
        const more: u8 = if (end < png.len) 1 else 0;
        if (first) {
            try writer.print("\x1b_Ga=T,U=1,f=100,t=d,q=2,i={d},c={d},r={d},m={d};", .{ image_id, cols, rows, more });
            first = false;
        } else {
            try writer.print("\x1b_Gm={d};", .{more});
        }
        try writer.writeAll(encoded);
        try writer.writeAll("\x1b\\");
        if (more == 0) break;
        offset = end;
    }
}

/// Frees image `image_id` and its placements in the terminal.
pub fn writeDelete(writer: *std.Io.Writer, image_id: u32) !void {
    try writer.print("\x1b_Ga=d,d=I,i={d},q=2\x1b\\", .{image_id});
}

/// Capability query: a supporting terminal answers `ESC _ G i=<id>;OK ESC \`.
pub fn queryBytes(query_id: u32) [64]u8 {
    var buf: [64]u8 = @splat(0);
    _ = std.fmt.bufPrint(&buf, "\x1b_Gi={d},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\", .{query_id}) catch unreachable;
    return buf;
}

test "small payloads fit in one transmit command" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeTransmitPng(&out.writer, 42, "abc", 10, 4);
    try std.testing.expectEqualStrings("\x1b_Ga=T,U=1,f=100,t=d,q=2,i=42,c=10,r=4,m=0;YWJj\x1b\\", out.written());
}

test "large payloads split into chunks of at most 4096 base64 bytes" {
    const alloc = std.testing.allocator;
    const payload = try alloc.alloc(u8, 3072 * 2 + 5);
    defer alloc.free(payload);
    @memset(payload, 'x');
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeTransmitPng(&out.writer, 1, payload, 2, 2);
    const bytes = out.written();
    try std.testing.expectEqual(@as(usize, 3), std.mem.count(u8, bytes, "\x1b_G"));
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, bytes, "m=1;"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, bytes, "\x1b_Gm=0;"));
    var it = std.mem.splitSequence(u8, bytes, "\x1b\\");
    while (it.next()) |command| {
        if (command.len == 0) continue;
        const semicolon = std.mem.indexOfScalar(u8, command, ';').?;
        try std.testing.expect(command.len - semicolon - 1 <= 4096);
    }
}
