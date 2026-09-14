//! Subscription provider selection. Authentication is owned by app_auth_runtime.
const std = @import("std");
const provider_catalog = @import("../auth/provider_catalog.zig");
const provider_picker_catalog = @import("../auth/provider_picker_catalog.zig");
const model_provider = @import("../config/model_provider.zig");
const picker_state = @import("../input/picker_state.zig");
const list_window = @import("../shared/list_window.zig");
const runtime_profile = @import("../hosts/runtime_profile.zig");
const app_auth_runtime = @import("app_auth_runtime.zig");
const provider_runtime = @import("provider_runtime.zig");

pub const ColumnBuffer = struct {
    labels: [provider_picker_catalog.max_column_options][]const u8 = undefined,
    annotations: [provider_picker_catalog.max_column_options][]const u8 = undefined,
    count: usize = 0,
};

pub fn supported(comptime App: type) bool {
    return runtime_profile.allows(App, .native_auth) and
        @hasField(App, "input_runtime") and @hasField(App, "auth") and provider_runtime.supported(App);
}

pub fn Runtime(comptime App: type) type {
    return struct {
        pub fn columnOptions(app: *App, query: picker_state.ProviderPickerQuery, column: *ColumnBuffer) usize {
            column.count = 0;
            if (comptime !supported(App)) return 0;
            if (query.stage != .provider) return 0;
            if (app.auth.sourceInventoryRefreshActive()) {
                column.labels[0] = "checking credentials...";
                column.annotations[0] = "";
                column.count = 1;
                return 1;
            }
            var slugs: [provider_picker_catalog.max_provider_options][]const u8 = undefined;
            const count = provider_picker_catalog.providerOptions(&slugs);
            for (slugs[0..count], 0..) |slug, i| {
                const id = provider_catalog.parse(slug).?;
                column.labels[i] = slug;
                column.annotations[i] = if (id == provider_runtime.provider(app) and
                    model_provider.authorizesCredential(id, app.auth.credentialSource())) "current" else "";
            }
            column.count = picker_state.filterAnnotatedLabels(query.query, &column.labels, &column.annotations, count);
            return column.count;
        }

        pub fn hasQuery(app: *App) bool {
            if (comptime !supported(App)) return false;
            const query = app.input_runtime.picker.activeProviderPickerQuery(&app.input_runtime.edit_state) orelse return false;
            return query.stage == .provider;
        }

        pub fn navigate(app: *App, delta: i32) void {
            if (comptime !supported(App)) return;
            if (app.auth.sourceInventoryRefreshActive() or !hasQuery(app)) return;
            const query = app.input_runtime.picker.activeProviderPickerQuery(&app.input_runtime.edit_state).?;
            var column: ColumnBuffer = .{};
            const count = columnOptions(app, query, &column);
            const picker = &app.input_runtime.picker;
            list_window.advanceSelection(&picker.provider_column_index, &picker.provider_column_window_start, count, delta);
        }

        pub fn autocomplete(app: *App) !void {
            if (comptime !supported(App)) return;
            if (app.auth.sourceInventoryRefreshActive() or !hasQuery(app)) return;
            const query = app.input_runtime.picker.activeProviderPickerQuery(&app.input_runtime.edit_state).?;
            var column: ColumnBuffer = .{};
            _ = columnOptions(app, query, &column);
            const selected = selectedLabel(app, query, &column) orelse return;
            const text = try std.fmt.allocPrint(app.alloc, "{s}{s}", .{ query.prefix, selected });
            defer app.alloc.free(text);
            try app.input_runtime.textReplacementState().replace(app.alloc, text);
            app.shell.render_requests.request(.footer);
        }

        // Space never commits a provider or triggers authentication.
        pub fn advanceOnSpace(_: *App) !bool {
            return false;
        }
        pub fn stepBack(_: *App) !bool {
            return false;
        }

        pub fn submit(app: *App) !bool {
            if (comptime !supported(App)) return false;
            if (!hasQuery(app)) return false;
            if (app.auth.sourceInventoryRefreshActive()) return true;
            const query = app.input_runtime.picker.activeProviderPickerQuery(&app.input_runtime.edit_state).?;
            var column: ColumnBuffer = .{};
            _ = columnOptions(app, query, &column);
            const selected = selectedLabel(app, query, &column) orelse return false;
            const provider = provider_catalog.parse(selected) orelse return false;
            app.input_runtime.picker.clearProviderPichandworklow();
            app.input_runtime.inputResetState().clearCurrent(app.alloc);
            try app_auth_runtime.Runtime(App).applyPickerChoice(app, .{ .provider = provider });
            app.shell.render_requests.request(.footer);
            return true;
        }

        pub fn abandon(app: *App) void {
            if (comptime !supported(App)) return;
            app.input_runtime.picker.clearProviderPichandworklow();
        }

        pub fn closeKeyColumn(_: *App) void {}

        fn selectedLabel(app: *App, query: picker_state.ProviderPickerQuery, column: *const ColumnBuffer) ?[]const u8 {
            if (column.count == 0) return null;
            if (exactLabel(query.query, column)) |label| return label;
            return column.labels[app.input_runtime.picker.provider_column_index % column.count];
        }
    };
}

fn exactLabel(raw_query: []const u8, column: *const ColumnBuffer) ?[]const u8 {
    const query = std.mem.trim(u8, raw_query, " \t");
    if (query.len == 0) return null;
    for (column.labels[0..column.count]) |candidate| {
        if (std.ascii.eqlIgnoreCase(candidate, query)) return candidate;
    }
    return null;
}

test "provider labels match exactly without accepting the removed provider" {
    var column: ColumnBuffer = .{};
    column.labels[0] = "codex";
    column.labels[1] = "grok";
    column.count = 2;
    try std.testing.expectEqualStrings("codex", exactLabel(" CODEX ", &column).?);
    try std.testing.expect(exactLabel("cod", &column) == null);
}
