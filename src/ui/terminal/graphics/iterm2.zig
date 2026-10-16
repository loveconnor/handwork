//! iTerm2 inline image protocol (OSC 1337 File=), also implemented by
//! WezTerm, VS Code's terminal, and others.
//! Reference: https://iterm2.com/documentation-images.html

const std = @import("std");

/// Draws `png` at the cursor, stretched to exactly `cols` x `rows` cells.
/// The caller sizes the PNG to that cell box, so disabling aspect
/// preservation never distorts it but keeps the terminal from letterboxing.
pub fn writeInlinePng(writer: *std.Io.Writer, png: []const u8, cols: u16, rows: u16) !void {
    try writer.print("\x1b]1337;File=inline=1;size={d};width={d};height={d};preserveAspectRatio=0:", .{ png.len, cols, rows });
    try std.base64.standard.Encoder.encodeWriter(writer, png);
    try writer.writeAll("\x07");
}

test "inline image escape names the cell box and payload size" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeInlinePng(&out.writer, "abc", 12, 3);
    try std.testing.expectEqualStrings(
        "\x1b]1337;File=inline=1;size=3;width=12;height=3;preserveAspectRatio=0:YWJj\x07",
        out.written(),
    );
}
