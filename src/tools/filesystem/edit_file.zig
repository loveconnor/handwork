const std = @import("std");
const file_mutation_contract = @import("../../core/tooling/file_mutation_contract.zig");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");

const Allocator = std.mem.Allocator;
const max_content_bytes: usize = 4 * 1024 * 1024;

/// Typed input for the core edit_file tool.
pub const Input = struct {
    path: []u8,
    old_string: []u8,
    new_string: []u8,
    edits: []file_mutation_contract.EditReplacement = &.{},

    pub fn deinit(self: *Input, alloc: Allocator) void {
        alloc.free(self.path);
        alloc.free(self.old_string);
        alloc.free(self.new_string);
        for (self.edits) |edit| {
            alloc.free(edit.old_string);
            alloc.free(edit.new_string);
        }
        alloc.free(self.edits);
        self.* = .{ .path = &.{}, .old_string = &.{}, .new_string = &.{} };
    }
};

/// Decodes edit_file JSON into an owned Input released by ToolInput.deinit.
pub fn decode(
    ctx: tool_dispatch.DispatchContext,
    args_json: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        ctx.allocator,
        args_json,
        .{},
    ) catch {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file arguments must be valid JSON",
        ) };
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file arguments must be an object",
        ) };
    }

    const path_value = parsed.value.object.get("path") orelse {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file requires string field \"path\"",
        ) };
    };
    if (path_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file field \"path\" must be a string",
        ) };
    }

    if (parsed.value.object.get("edits")) |edits| {
        if (parsed.value.object.contains("old_string") or parsed.value.object.contains("new_string"))
            return .{ .failure = try ctx.allocator.dupe(u8, "edit_file accepts edits OR old_string/new_string, not both") };
        if (edits != .array or edits.array.items.len == 0 or edits.array.items.len > file_mutation_contract.max_edit_replacements)
            return .{ .failure = try ctx.allocator.dupe(u8, "edit_file edits must contain 1 to 32 replacements") };
        var bytes: usize = 0;
        for (edits.array.items) |edit| {
            if (edit != .object) return .{ .failure = try ctx.allocator.dupe(u8, "edit_file replacements must be objects") };
            const old = edit.object.get("old_string");
            const new = edit.object.get("new_string");
            if (old == null or new == null or old.? != .string or new.? != .string)
                return .{ .failure = try ctx.allocator.dupe(u8, "edit_file replacements require old_string and new_string strings") };
            bytes = std.math.add(usize, bytes, old.?.string.len) catch max_content_bytes + 1;
            bytes = std.math.add(usize, bytes, new.?.string.len) catch max_content_bytes + 1;
            if (bytes > max_content_bytes) return .{ .failure = try ctx.allocator.dupe(u8, "edit_file edits exceed the 4 MiB preparation limit") };
        }
        const input = try ctx.allocator.create(Input);
        errdefer ctx.allocator.destroy(input);
        input.* = .{ .path = &.{}, .old_string = &.{}, .new_string = &.{} };
        errdefer input.deinit(ctx.allocator);
        input.path = try ctx.allocator.dupe(u8, path_value.string);
        input.edits = try ctx.allocator.alloc(file_mutation_contract.EditReplacement, edits.array.items.len);
        for (input.edits) |*edit| edit.* = .{ .old_string = &.{}, .new_string = &.{} };
        for (edits.array.items, input.edits) |source, *dest| {
            dest.old_string = try ctx.allocator.dupe(u8, source.object.get("old_string").?.string);
            dest.new_string = try ctx.allocator.dupe(u8, source.object.get("new_string").?.string);
        }
        return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
    }

    const old_value = parsed.value.object.get("old_string") orelse {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file requires string field \"old_string\"",
        ) };
    };
    if (old_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file field \"old_string\" must be a string",
        ) };
    }

    const new_value = parsed.value.object.get("new_string") orelse {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file requires string field \"new_string\"",
        ) };
    };
    if (new_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file field \"new_string\" must be a string",
        ) };
    }

    const input = try ctx.allocator.create(Input);
    errdefer ctx.allocator.destroy(input);
    const owned_path = try ctx.allocator.dupe(u8, path_value.string);
    errdefer ctx.allocator.free(owned_path);
    const owned_old = try ctx.allocator.dupe(u8, old_value.string);
    errdefer ctx.allocator.free(owned_old);
    const owned_new = try ctx.allocator.dupe(u8, new_value.string);
    errdefer ctx.allocator.free(owned_new);
    input.* = .{
        .path = owned_path,
        .old_string = owned_old,
        .new_string = owned_new,
    };
    return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
}

fn inputDeinit(ptr: *anyopaque, alloc: Allocator) void {
    const input: *Input = @ptrCast(@alignCast(ptr));
    input.deinit(alloc);
    alloc.destroy(input);
}

pub fn takeFileMutationInput(
    tool_input: tool_dispatch.ToolInput,
    alloc: Allocator,
) file_mutation_contract.FileMutationInput {
    const input = tool_input.as(Input);
    const moved = file_mutation_contract.EditInput{
        .path = input.path,
        .old_string = input.old_string,
        .new_string = input.new_string,
        .edits = input.edits,
    };
    alloc.destroy(input);
    return .{ .edit = moved };
}

pub fn validate(
    ctx: tool_dispatch.DispatchContext,
    tool_input: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!?[]u8 {
    const input = tool_input.as(Input);
    if (input.path.len > std.Io.Dir.max_path_bytes) {
        return try ctx.allocator.dupe(
            u8,
            "file mutation preparation failed: path exceeds the preparation limit",
        );
    }
    if (input.old_string.len > max_content_bytes) {
        return try ctx.allocator.dupe(
            u8,
            "edit_file failed: old_string exceeds the 4 MiB preparation limit",
        );
    }
    if (input.new_string.len > max_content_bytes) {
        return try ctx.allocator.dupe(
            u8,
            "edit_file failed: new_string exceeds the 4 MiB preparation limit",
        );
    }
    return null;
}

pub fn call(
    ctx: tool_dispatch.DispatchContext,
    _: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    return .{ .failure = try ctx.allocator.dupe(
        u8,
        "edit_file execution requires canonical tool runtime authorization",
    ) };
}

/// Reports that edit_file mutates filesystem state.
pub fn readsOnly(_: tool_dispatch.ToolInput) bool {
    return false;
}

/// Reports that edit_file can destroy prior file content.
pub fn isIrreversible(_: tool_dispatch.ToolInput) bool {
    return true;
}

fn noopInputDeinit(_: *anyopaque, _: Allocator) void {}

test "edit_file decodes invalid argument shapes as failures" {
    const cases = [_]struct {
        json: []const u8,
        reason: []const u8,
    }{
        .{ .json = "{", .reason = "edit_file arguments must be valid JSON" },
        .{ .json = "[]", .reason = "edit_file arguments must be an object" },
        .{ .json = "{\"old_string\":\"a\",\"new_string\":\"b\"}", .reason = "edit_file requires string field \"path\"" },
        .{ .json = "{\"path\":1,\"old_string\":\"a\",\"new_string\":\"b\"}", .reason = "edit_file field \"path\" must be a string" },
        .{ .json = "{\"path\":\"/tmp/x\",\"new_string\":\"b\"}", .reason = "edit_file requires string field \"old_string\"" },
        .{ .json = "{\"path\":\"/tmp/x\",\"old_string\":1,\"new_string\":\"b\"}", .reason = "edit_file field \"old_string\" must be a string" },
        .{ .json = "{\"path\":\"/tmp/x\",\"old_string\":\"a\"}", .reason = "edit_file requires string field \"new_string\"" },
        .{ .json = "{\"path\":\"/tmp/x\",\"old_string\":\"a\",\"new_string\":1}", .reason = "edit_file field \"new_string\" must be a string" },
    };

    for (cases) |case| {
        const decoded = try decode(
            .{ .allocator = std.testing.allocator },
            case.json,
        );
        switch (decoded) {
            .failure => |reason| {
                defer std.testing.allocator.free(reason);
                try std.testing.expectEqualStrings(case.reason, reason);
            },
            .input => |input| {
                input.deinit(std.testing.allocator);
                return error.TestExpectedDecodeFailure;
            },
        }
    }
}

test "edit_file decodes owned typed input" {
    const decoded = try decode(
        .{ .allocator = std.testing.allocator },
        "{\"path\":\"file.txt\",\"old_string\":\"old\",\"new_string\":\"new\"}",
    );
    const erased = switch (decoded) {
        .input => |input| input,
        .failure => |reason| {
            defer std.testing.allocator.free(reason);
            return error.TestExpectedDecodedInput;
        },
    };
    defer erased.deinit(std.testing.allocator);
    const input = erased.as(Input);
    try std.testing.expectEqualStrings("file.txt", input.path);
    try std.testing.expectEqualStrings("old", input.old_string);
    try std.testing.expectEqualStrings("new", input.new_string);
    try std.testing.expect(
        try validate(.{ .allocator = std.testing.allocator }, erased) == null,
    );
}

test "edit_file validation enforces independent preparation limits" {
    const alloc = std.testing.allocator;
    const oversized_path = try alloc.alloc(u8, std.Io.Dir.max_path_bytes + 1);
    defer alloc.free(oversized_path);
    @memset(oversized_path, 'p');
    const oversized_value = try alloc.alloc(u8, 4 * 1024 * 1024 + 1);
    defer alloc.free(oversized_value);
    @memset(oversized_value, 'x');

    const cases = [_]struct {
        input: Input,
        reason: []const u8,
    }{
        .{
            .input = .{
                .path = oversized_path,
                .old_string = @constCast("old"),
                .new_string = @constCast("new"),
            },
            .reason = "file mutation preparation failed: path exceeds the preparation limit",
        },
        .{
            .input = .{
                .path = @constCast("file.txt"),
                .old_string = oversized_value,
                .new_string = @constCast("new"),
            },
            .reason = "edit_file failed: old_string exceeds the 4 MiB preparation limit",
        },
        .{
            .input = .{
                .path = @constCast("file.txt"),
                .old_string = @constCast("old"),
                .new_string = oversized_value,
            },
            .reason = "edit_file failed: new_string exceeds the 4 MiB preparation limit",
        },
    };

    for (cases) |case| {
        var input = case.input;
        const erased = tool_dispatch.ToolInput{
            .ptr = &input,
            .deinit_fn = noopInputDeinit,
        };
        const reason = try validate(.{ .allocator = alloc }, erased) orelse
            return error.TestExpectedValidationFailure;
        defer alloc.free(reason);
        try std.testing.expectEqualStrings(case.reason, reason);
    }
}

fn decodeBatchAllocationTest(alloc: Allocator) !void {
    const decoded = try decode(.{ .allocator = alloc },
        \\{"path":"note.txt","edits":[{"old_string":"a","new_string":"A"},{"old_string":"b","new_string":"B"}]}
    );
    const input = switch (decoded) {
        .input => |value| value,
        .failure => return error.UnexpectedFailure,
    };
    var moved = takeFileMutationInput(input, alloc);
    defer moved.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 2), moved.edit.edits.len);
    try std.testing.expectEqualStrings("b", moved.edit.edits[1].old_string);
}

test "edit_file batch ownership survives allocation failures and transfer" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, decodeBatchAllocationTest, .{});
}

test "edit_file rejects malformed and mixed batches" {
    for ([_][]const u8{
        \\{"path":"x","edits":[]}
        ,
        \\{"path":"x","edits":true}
        ,
        \\{"path":"x","edits":[{}]}
        ,
        \\{"path":"x","edits":[{"old_string":"a","new_string":1}]}
        ,
        \\{"path":"x","old_string":"a","new_string":"b","edits":[{"old_string":"a","new_string":"c"}]}
    }) |json| {
        const decoded = try decode(.{ .allocator = std.testing.allocator }, json);
        switch (decoded) {
            .failure => |reason| std.testing.allocator.free(reason),
            .input => |input| {
                input.deinit(std.testing.allocator);
                return error.ExpectedFailure;
            },
        }
    }
}
