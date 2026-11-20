//! Comptime repetition of strings and arrays.
//!
//! Zig 0.17 removed the `a ** n` array multiplication operator. Single-element
//! arrays use `@splat`; this helper covers string literals and multi-element
//! arrays, keeping the old result shape: `*const [N:0]u8` for string literals
//! (and other pointers to arrays) and `[N]T` for array values.

fn ArrayOf(comptime T: type) @import("std").lang.Type.Array {
    return switch (@typeInfo(T)) {
        .array => |array| array,
        .pointer => |pointer| switch (@typeInfo(pointer.child)) {
            .array => |array| array,
            else => @compileError("repeat expects an array or pointer to array, found " ++ @typeName(T)),
        },
        else => @compileError("repeat expects an array or pointer to array, found " ++ @typeName(T)),
    };
}

fn RepeatedArray(comptime T: type, comptime count: usize) type {
    const array = ArrayOf(T);
    return if (array.sentinel()) |s|
        [array.len * count:s]array.child
    else
        [array.len * count]array.child;
}

fn Repeated(comptime T: type, comptime count: usize) type {
    return if (@typeInfo(T) == .pointer)
        *const RepeatedArray(T, count)
    else
        RepeatedArray(T, count);
}

/// Returns `value` repeated `count` times, matching the removed `value ** count`.
pub inline fn repeat(comptime value: anytype, comptime count: usize) Repeated(@TypeOf(value), count) {
    const T = @TypeOf(value);
    const final = comptime blk: {
        const items = if (@typeInfo(T) == .pointer) value.* else value;
        const len = items.len;
        if (len == 1) break :blk @as(RepeatedArray(T, count), @splat(items[0]));
        var out: RepeatedArray(T, count) = undefined;
        if (count == 0 or len == 0) break :blk out;
        out[0..len].* = items;
        // Double the filled prefix to keep comptime evaluation logarithmic.
        var filled: usize = len;
        const total = len * count;
        while (filled < total) {
            const n = @min(filled, total - filled);
            @memcpy(out[filled..][0..n], out[0..n]);
            filled += n;
        }
        break :blk out;
    };
    return if (@typeInfo(T) == .pointer) &final else final;
}

test repeat {
    const std = @import("std");
    try std.testing.expectEqualStrings("ababab", repeat("ab", 3));
    try std.testing.expectEqual(@as(usize, 0), repeat("x", 3)[3]);
    try std.testing.expectEqual([4]u8{ 1, 2, 1, 2 }, repeat([_]u8{ 1, 2 }, 2));
    try std.testing.expectEqualStrings("", repeat("x", 0));
    const long = repeat("h", 150_000);
    try std.testing.expectEqual(@as(usize, 150_000), long.len);
}
