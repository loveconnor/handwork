const std = @import("std");

pub const url = "https://connorlove.com";

test "feedback URL stays on the connorlove.com domain" {
    try std.testing.expectEqualStrings("https://connorlove.com", url);
}
