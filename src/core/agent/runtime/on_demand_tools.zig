const std = @import("std");
const schema = @import("../../tooling/model_tool_schema.zig");
const stream = @import("../stream_provider.zig");
const types = @import("../../shared/types.zig");
const io = @import("../../shared/io.zig");

pub fn enabled() bool {
    return !std.mem.eql(u8, io.getenv("HANDWORK_ON_DEMAND_TOOLS") orelse "1", "0");
}

fn contains(names: []const []const u8, name: []const u8) bool {
    for (names) |entry| if (std.mem.eql(u8, entry, name)) return true;
    return false;
}

fn deferred(name: []const u8) bool {
    return contains(&.{ "glob_files", "grep_files", "edit_file", "write_file", "shell", "subagent", "capability_search", "skill", "install_skill", "mcp_select_tool", "mcp_features", "ask_user_question", "web_fetch", "web_search", "read_tool_result" }, name);
}

/// Turn-owned advertisement state. This never changes the executor registry or authority.
pub const State = struct {
    active: bool,
    selected: std.ArrayList([]const u8) = .empty,

    pub fn init(functions: []const schema.FunctionSchema, use_on_demand: bool) State {
        const loader = for (functions) |f| {
            if (std.mem.eql(u8, f.name, "load_tools")) break true;
        } else false;
        return .{ .active = use_on_demand and loader };
    }

    pub fn select(self: *State, alloc: std.mem.Allocator, names: []const []const u8) !void {
        for (names) |name| {
            if (!contains(self.selected.items, name)) {
                const owned = try alloc.dupe(u8, name);
                errdefer alloc.free(owned);
                try self.selected.append(alloc, owned);
            }
        }
    }

    pub fn deinit(self: *State, alloc: std.mem.Allocator) void {
        for (self.selected.items) |name| alloc.free(name);
        self.selected.deinit(alloc);
    }

    pub fn restore(self: *State, alloc: std.mem.Allocator, messages: []const types.ChatMessage) !void {
        for (messages, 0..) |message, message_index| for (message.tool_calls) |call| {
            // Remember used tools across turns/recovery. Current catalog filtering still applies.
            try self.select(alloc, &.{call.name});
            if (!std.mem.eql(u8, call.name, "load_tools")) continue;
            const succeeded = for (messages[message_index + 1 ..]) |result| {
                if (result.role == .assistant) break false;
                if (result.role == .tool and result.tool_call_id != null and std.mem.eql(u8, result.tool_call_id.?, call.id)) {
                    break result.tool_result_status == .success;
                }
            } else false;
            if (!succeeded) continue;
            const parsed = std.json.parseFromSlice(std.json.Value, alloc, call.arguments_json, .{}) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => continue,
            };
            defer parsed.deinit();
            if (parsed.value != .object) continue;
            const names = parsed.value.object.get("names") orelse continue;
            if (names != .array or names.array.items.len > 64) continue;
            for (names.array.items) |name| {
                if (name == .string and name.string.len <= 128) try self.select(alloc, &.{name.string});
            }
        };
    }

    pub fn project(self: *const State, alloc: std.mem.Allocator, source: stream.ToolSelection) !stream.ToolSelection {
        var result = source;
        var functions: std.ArrayList(schema.FunctionSchema) = .empty;
        var names: std.ArrayList([]const u8) = .empty;
        var catalog: std.Io.Writer.Allocating = .init(alloc);
        defer catalog.deinit();
        try catalog.writer.writeAll("Load tool definitions by exact name before use; batch names. Available: ");
        var first = true;
        for (source.advertised_functions) |f| {
            if (!deferred(f.name)) continue;
            if (!first) try catalog.writer.writeAll(", ");
            try catalog.writer.writeAll(f.name);
            first = false;
        }
        try catalog.writer.writeAll(". Definitions persist for this conversation; loading executes nothing and grants no permission.");
        for (source.advertised_functions) |f| {
            const loader = std.mem.eql(u8, f.name, "load_tools");
            if (loader and !self.active) continue;
            if (self.active and deferred(f.name) and !contains(self.selected.items, f.name)) continue;
            var offered = f;
            if (loader) offered.description = try alloc.dupe(u8, catalog.written());
            try functions.append(alloc, offered);
            try names.append(alloc, f.name);
        }
        // Provider-native tools have no local function schema; preserve their advertisements.
        for (source.advertised_names) |name| {
            const local = for (source.advertised_functions) |f| {
                if (std.mem.eql(u8, f.name, name)) break true;
            } else false;
            if (!local and !contains(names.items, name)) try names.append(alloc, name);
        }
        result.advertised_functions = try functions.toOwnedSlice(alloc);
        result.advertised_names = try names.toOwnedSlice(alloc);
        return result;
    }
};

test "on demand preserves every eligible builtin schema after selection" {
    const builtin_tools = @import("../../../builtins/tools.zig");
    const projection = @import("../../tooling/tool_projection.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var full = try projection.buildModelToolProjectionForSet(alloc, builtin_tools.advertisement_set, .{ .subagent_available = true });
    defer full.deinit(alloc);
    const source = stream.ToolSelection{ .registry = builtin_tools.registry, .advertised_names = full.advertised_names, .advertised_functions = full.advertised_functions };
    var state = State.init(full.advertised_functions, true);
    defer state.deinit(alloc);
    const initial = try state.project(alloc, source);
    try std.testing.expectEqual(@as(usize, 2), initial.advertised_functions.len);
    try std.testing.expect(initial.advertisedFunction("load_tools") != null);
    try std.testing.expect(initial.advertisedFunction("read_file") != null);
    try std.testing.expect(initial.advertisedFunction("shell") == null);
    for (full.advertised_functions) |f| {
        if (deferred(f.name)) try std.testing.expect(std.mem.indexOf(u8, initial.advertisedFunction("load_tools").?.description, f.name) != null);
    }
    try state.select(alloc, full.advertised_names);
    try state.select(alloc, full.advertised_names);
    const loaded = try state.project(alloc, source);
    try std.testing.expectEqual(full.advertised_functions.len, loaded.advertised_functions.len);
    for (full.advertised_functions) |f| {
        const after = loaded.advertisedFunction(f.name).?;
        try std.testing.expectEqualDeep(f.input_schema, after.input_schema);
        if (!std.mem.eql(u8, f.name, "load_tools")) try std.testing.expectEqualStrings(f.description, after.description);
    }
    try std.testing.expect(!@import("parallel_execution.zig").isReadOnlyCall(builtin_tools.registry, .{ .id = "load", .name = "load_tools", .arguments_json = "{\"names\":[\"shell\"]}" }));
}

test "on demand never restores removed tools and preserves custom native and dynamic tools" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const functions = [_]schema.FunctionSchema{
        .{ .name = "load_tools", .description = "load" },
        .{ .name = "read_file", .description = "read" },
        .{ .name = "custom_host_tool", .description = "custom" },
    };
    var state = State.init(&functions, true);
    defer state.deinit(alloc);
    try state.restore(alloc, &.{.{ .role = .assistant, .tool_calls = &.{.{ .id = "old", .name = "load_tools", .arguments_json = "{\"names\":[\"shell\"]}" }} }});
    const source = stream.ToolSelection{ .advertised_names = &.{ "load_tools", "read_file", "custom_host_tool", "web_search" }, .advertised_functions = &functions, .selected_dynamic = &.{.{ .name = "mcp_test", .description = "MCP", .input_schema = .{ .object = .empty } }} };
    const result = try state.project(alloc, source);
    try std.testing.expect(result.advertisedFunction("shell") == null);
    try std.testing.expect(std.mem.indexOf(u8, result.advertisedFunction("load_tools").?.description, "shell") == null);
    try std.testing.expect(result.advertisedFunction("custom_host_tool") != null);
    try std.testing.expect(contains(result.advertised_names, "web_search"));
    try std.testing.expectEqualDeep(source.selected_dynamic, result.selected_dynamic);
}

test "on demand restores used and loaded tools and supports eager rollback" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const functions = [_]schema.FunctionSchema{
        .{ .name = "load_tools", .description = "load" },
        .{ .name = "shell", .description = "run" },
        .{ .name = "edit_file", .description = "edit" },
    };
    const source = stream.ToolSelection{ .advertised_names = &.{ "load_tools", "shell", "edit_file" }, .advertised_functions = &functions };
    var state = State.init(&functions, true);
    defer state.deinit(alloc);
    try state.restore(alloc, &.{ .{ .role = .assistant, .tool_calls = &.{
        .{ .id = "a", .name = "shell", .arguments_json = "{}" },
        .{ .id = "b", .name = "load_tools", .arguments_json = "{\"names\":[\"edit_file\"]}" },
        .{ .id = "c", .name = "load_tools", .arguments_json = "broken" },
    } }, .{ .role = .tool, .tool_call_id = "b", .tool_result_status = .success } });
    const restored = try state.project(alloc, source);
    try std.testing.expect(restored.advertisedFunction("shell") != null);
    try std.testing.expect(restored.advertisedFunction("edit_file") != null);
    const eager = State.init(&functions, false);
    const rollback = try eager.project(alloc, source);
    try std.testing.expect(rollback.advertisedFunction("load_tools") == null);
    try std.testing.expect(rollback.advertisedFunction("shell") != null);
    try std.testing.expect(!State.init(functions[1..], true).active);
}

test "on demand does not restore failed interrupted or unknown selection results" {
    for ([_]?types.PersistedToolStatus{ .failure, null }) |status| {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const functions = [_]schema.FunctionSchema{ .{ .name = "load_tools", .description = "load" }, .{ .name = "shell", .description = "run" } };
        var state = State.init(&functions, true);
        defer state.deinit(arena.allocator());
        try state.restore(arena.allocator(), &.{
            .{ .role = .assistant, .tool_calls = &.{.{ .id = "failed", .name = "load_tools", .arguments_json = "{\"names\":[\"shell\",\"missing\"]}" }} },
            .{ .role = .tool, .tool_call_id = "failed", .tool_result_status = status },
            .{ .role = .assistant, .tool_calls = &.{.{ .id = "interrupted", .name = "load_tools", .arguments_json = "{\"names\":[\"shell\"]}" }} },
        });
        const projected = try state.project(arena.allocator(), .{ .advertised_names = &.{ "load_tools", "shell" }, .advertised_functions = &functions });
        try std.testing.expect(projected.advertisedFunction("shell") == null);
    }
}
