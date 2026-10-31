const std = @import("std");
const dispatch = @import("../../core/tooling/tool_dispatch.zig");

pub const Input = struct {
    names: []const []const u8,
};

pub fn decode(ctx: dispatch.DispatchContext, args: []const u8) dispatch.DispatchError!dispatch.DecodeResult {
    const parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, args, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return failure(ctx, "Expected {\"names\":[\"tool_name\",...]}"),
    };
    defer parsed.deinit();
    if (parsed.value != .object or parsed.value.object.count() != 1) return failure(ctx, "Expected only names, an array of exact tool names");
    const names = parsed.value.object.get("names") orelse return failure(ctx, "names is required");
    if (names != .array or names.array.items.len == 0 or names.array.items.len > 64) return failure(ctx, "names must contain 1-64 exact tool names");
    for (names.array.items) |name| {
        if (name != .string or name.string.len == 0 or name.string.len > 128) return failure(ctx, "Each name must be a string of 1-128 bytes");
    }
    const input = try ctx.allocator.create(Input);
    errdefer ctx.allocator.destroy(input);
    const owned = try ctx.allocator.alloc([]const u8, names.array.items.len);
    errdefer ctx.allocator.free(owned);
    var initialized: usize = 0;
    errdefer for (owned[0..initialized]) |name| ctx.allocator.free(name);
    for (names.array.items, 0..) |name, index| {
        owned[index] = try ctx.allocator.dupe(u8, name.string);
        initialized += 1;
    }
    input.* = .{ .names = owned };
    return .{ .input = .{ .ptr = input, .deinit_fn = deinit } };
}

fn failure(ctx: dispatch.DispatchContext, text: []const u8) !dispatch.DecodeResult {
    return .{ .failure = try ctx.allocator.dupe(u8, text) };
}

fn deinit(ptr: *anyopaque, alloc: std.mem.Allocator) void {
    const input: *Input = @ptrCast(@alignCast(ptr));
    for (input.names) |name| alloc.free(name);
    alloc.free(input.names);
    alloc.destroy(input);
}

pub fn call(ctx: dispatch.DispatchContext, erased: dispatch.ToolInput) dispatch.DispatchError!dispatch.ToolResult {
    const sink = ctx.selected_builtin_tool_names_sink orelse return .{ .failure = try ctx.allocator.dupe(u8, "Tool loading is unavailable in this host") };
    const input = erased.as(Input);
    // Selection is atomic and restricted to the owning turn's eligible catalog.
    for (input.names) |name| {
        const available = for (ctx.loadable_tool_names) |allowed| {
            if (std.mem.eql(u8, name, allowed)) break true;
        } else false;
        if (!available) return .{ .failure = try std.fmt.allocPrint(ctx.allocator, "Tool unavailable: {s}. Use an exact name from the available catalog.", .{name}) };
    }
    const selected = try ctx.allocator.alloc([]const u8, input.names.len);
    var initialized: usize = 0;
    errdefer {
        for (selected[0..initialized]) |name| ctx.allocator.free(name);
        ctx.allocator.free(selected);
    }
    for (input.names, 0..) |name, index| {
        selected[index] = try ctx.allocator.dupe(u8, name);
        initialized += 1;
    }
    const output = try ctx.allocator.dupe(u8, "Requested tool definitions are available on the next response. Loading executes nothing and grants no permissions.");
    sink.* = selected;
    return .{ .success = output };
}

pub fn readsOnly(_: dispatch.ToolInput) bool {
    return true;
}
pub fn isIrreversible(_: dispatch.ToolInput) bool {
    return false;
}

test "load tools rejects invalid and unavailable names atomically" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var selected: []const []const u8 = &.{};
    const ctx = dispatch.DispatchContext{ .allocator = arena.allocator(), .loadable_tool_names = &.{"read_file"}, .selected_builtin_tool_names_sink = &selected };
    for ([_][]const u8{ "null", "{}", "{\"names\":[]}", "{\"names\":[12]}", "{\"names\":[\"read_file\"],\"extra\":true}" }) |args| {
        const decoded = try decode(ctx, args);
        try std.testing.expect(decoded == .failure);
    }
    const denied = try decode(ctx, "{\"names\":[\"read_file\",\"shell\"]}");
    defer denied.input.deinit(ctx.allocator);
    const rejected = try call(ctx, denied.input);
    try std.testing.expect(rejected == .failure);
    try std.testing.expectEqual(@as(usize, 0), selected.len);
    const allowed = try decode(ctx, "{\"names\":[\"read_file\"]}");
    defer allowed.input.deinit(ctx.allocator);
    const result = try call(ctx, allowed.input);
    try std.testing.expect(result == .success);
    try std.testing.expectEqualStrings("read_file", selected[0]);
}
