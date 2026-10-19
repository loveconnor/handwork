//! Sanitized subscription usage. Upstream bodies and identity never leave this module.
const std = @import("std");
const chatgpt_oauth = @import("chatgpt_oauth.zig");
const oauth_transport = @import("oauth_transport.zig");
const secret = @import("secret.zig");
const io_mod = @import("../shared/io.zig");
const Allocator = std.mem.Allocator;

const usage_url = "https://chatgpt.com/backend-api/wham/usage";
const max_body_bytes = 64 * 1024;
const timeout_ms = 15_000;

pub const Window = struct {
    id: []const u8,
    label: []const u8,
    usedPercent: f64,
    resetsAt: ?i64,
    windowMinutes: ?i64,
};

pub const Usage = struct {
    plan: ?[]const u8 = null,
    windows: [2]Window = undefined,
    count: usize = 0,

    pub fn write(self: *const Usage, w: *std.Io.Writer) !void {
        try std.json.Stringify.value(.{ .plan = self.plan, .windows = self.windows[0..self.count] }, .{}, w);
    }
};

// Refresh and usage share a deadline rather than each receiving a new timeout.
const BoundedTransport = struct {
    upstream: oauth_transport.Provider,
    deadline: std.Io.Clock.Timestamp,

    fn execute(raw: ?*anyopaque, alloc: Allocator, request: oauth_transport.Request) !oauth_transport.Response {
        const self: *@This() = @ptrCast(@alignCast(raw.?));
        var bounded = request;
        bounded.deadline = self.deadline;
        return self.upstream.execute(alloc, bounded);
    }

    fn provider(self: *@This()) oauth_transport.Provider {
        return .{ .context = self, .execute_fn = execute };
    }
};

pub fn load(alloc: Allocator, transport: oauth_transport.Provider) !Usage {
    var bounded = BoundedTransport{
        .upstream = transport,
        .deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{ .clock = .awake, .raw = .fromMilliseconds(timeout_ms) }),
    };
    var access = (try chatgpt_oauth.loadAccess(alloc, bounded.provider(), .if_needed)) orelse return error.UsageDisconnected;
    defer access.deinit(alloc);
    return fetch(alloc, bounded.provider(), &access);
}

fn fetch(alloc: Allocator, transport: oauth_transport.Provider, access: *const chatgpt_oauth.Access) !Usage {
    const authorization = try std.fmt.allocPrint(alloc, "Bearer {s}", .{access.access_token});
    defer secret.zeroAndFree(alloc, authorization);
    var response = try transport.execute(alloc, .{
        .method = .get,
        .url = usage_url,
        .authorization = authorization,
        .account_id = access.account_id,
    });
    defer response.deinit(alloc);
    if (response.disposition != .accepted) {
        if (response.status == .unauthorized or response.status == .forbidden) return error.UsageAuthFailed;
        return error.UsageRejected;
    }
    return parse(alloc, response.body);
}

const UpstreamWindow = struct {
    used_percent: ?f64 = null,
    reset_at: ?i64 = null,
    limit_window_seconds: ?i64 = null,
};
const Upstream = struct {
    plan_type: ?[]const u8 = null,
    rate_limit: ?struct {
        primary_window: ?UpstreamWindow = null,
        secondary_window: ?UpstreamWindow = null,
    } = null,
};

pub fn parse(alloc: Allocator, body: []const u8) !Usage {
    if (body.len > max_body_bytes) return error.UsageResponseTooLarge;
    const parsed = std.json.parseFromSlice(Upstream, alloc, body, .{ .ignore_unknown_fields = true }) catch |err| {
        if (err == error.OutOfMemory) return err;
        return error.InvalidUsageResponse;
    };
    defer parsed.deinit();
    var usage = Usage{ .plan = sanitizedPlan(parsed.value.plan_type) };
    if (parsed.value.rate_limit) |limits| {
        try appendWindow(&usage, "primary", limits.primary_window);
        try appendWindow(&usage, "secondary", limits.secondary_window);
    }
    return usage;
}

fn sanitizedPlan(plan: ?[]const u8) ?[]const u8 {
    const value = plan orelse return null;
    // Never echo arbitrary upstream strings, even in the plan field.
    for ([_][]const u8{ "free", "go", "plus", "pro", "team", "business", "enterprise", "edu" }) |known| {
        if (std.mem.eql(u8, known, value)) return known;
    }
    return null;
}

fn appendWindow(usage: *Usage, id: []const u8, source: ?UpstreamWindow) !void {
    const window = source orelse return;
    const percent = window.used_percent orelse return;
    if (!std.math.isFinite(percent) or percent < 0 or percent > 100) return error.InvalidUsageResponse;
    const minutes: ?i64 = if (window.limit_window_seconds) |seconds|
        (if (seconds > 0 and @mod(seconds, 60) == 0) @divExact(seconds, 60) else null)
    else
        null;
    const reset_ms: ?i64 = if (window.reset_at) |seconds| blk: {
        if (seconds < 0) break :blk null;
        // The desktop renders this through JavaScript Date, whose range is
        // narrower than i64 and must remain exactly representable as a number.
        if (seconds > 8_640_000_000_000) return error.InvalidUsageResponse;
        break :blk seconds * 1000;
    } else null;
    usage.windows[usage.count] = .{
        .id = id,
        .label = if (minutes == 300) "5-hour" else if (minutes == 10080) "Weekly" else if (std.mem.eql(u8, id, "primary")) "Primary" else "Secondary",
        .usedPercent = percent,
        .resetsAt = reset_ms,
        .windowMinutes = minutes,
    };
    usage.count += 1;
}

// These messages are the only failure details exposed over ACP.
pub fn errorMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.UsageDisconnected => "Codex is not connected",
        error.UsageAuthFailed, error.CredentialRefreshRejected, error.ChatGptAccountChanged => "Codex authentication failed; sign in again",
        error.Timeout, error.ConnectionTimedOut, error.ConnectionSetupTimedOut => "Codex usage request timed out",
        error.InvalidUsageResponse, error.UsageResponseTooLarge, error.OAuthResponseTooLarge => "Invalid Codex usage response",
        error.UsageRejected => "Codex usage request was rejected",
        else => "Could not load Codex usage",
    };
}

test "Codex usage parses durations independently and sanitizes serialized output" {
    const usage = try parse(std.testing.allocator,
        \\{"plan_type":"plus","account_id":"private-account","access_token":"private-token","rate_limit":{"primary_window":{"used_percent":12.5,"limit_window_seconds":604800,"reset_at":1700000000},"secondary_window":{"used_percent":0,"limit_window_seconds":18000,"reset_at":1700001234}},"extra":"private-body"}
    );
    try std.testing.expectEqualStrings("plus", usage.plan.?);
    try std.testing.expectEqual(@as(usize, 2), usage.count);
    try std.testing.expectEqualStrings("Weekly", usage.windows[0].label);
    try std.testing.expectEqualStrings("5-hour", usage.windows[1].label);
    try std.testing.expectEqual(@as(?i64, 10080), usage.windows[0].windowMinutes);
    try std.testing.expectEqual(@as(?i64, 1700000000000), usage.windows[0].resetsAt);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try usage.write(&out.writer);
    try std.testing.expectEqualStrings("{\"plan\":\"plus\",\"windows\":[{\"id\":\"primary\",\"label\":\"Weekly\",\"usedPercent\":12.5,\"resetsAt\":1700000000000,\"windowMinutes\":10080},{\"id\":\"secondary\",\"label\":\"5-hour\",\"usedPercent\":0,\"resetsAt\":1700001234000,\"windowMinutes\":300}]}", out.written());
}

test "Codex usage never fabricates missing quotas or plan names" {
    for ([_][]const u8{ "{}", "{\"rate_limit\":null}", "{\"plan_type\":\"private-token\",\"rate_limit\":{\"primary_window\":null,\"secondary_window\":{}}}" }) |body| {
        const usage = try parse(std.testing.allocator, body);
        try std.testing.expect(usage.plan == null);
        try std.testing.expectEqual(@as(usize, 0), usage.count);
    }
    const usage = try parse(std.testing.allocator, "{\"rate_limit\":{\"secondary_window\":{\"used_percent\":100,\"limit_window_seconds\":7200}}}");
    try std.testing.expectEqual(@as(usize, 1), usage.count);
    try std.testing.expectEqualStrings("secondary", usage.windows[0].id);
    try std.testing.expectEqualStrings("Secondary", usage.windows[0].label);
    try std.testing.expectEqual(@as(?i64, 120), usage.windows[0].windowMinutes);
    try std.testing.expect(usage.windows[0].resetsAt == null);
    const unknown = try parse(std.testing.allocator, "{\"rate_limit\":{\"primary_window\":{\"used_percent\":1}}}");
    try std.testing.expectEqualStrings("Primary", unknown.windows[0].label);
    try std.testing.expect(unknown.windows[0].windowMinutes == null);
}

test "Codex usage rejects malformed oversized and unsafe numbers" {
    for ([_][]const u8{ "not-json", "null", "[]", "{\"rate_limit\":{\"primary_window\":{\"used_percent\":-1}}}", "{\"rate_limit\":{\"primary_window\":{\"used_percent\":101}}}", "{\"rate_limit\":{\"primary_window\":{\"used_percent\":\"private-token\"}}}", "{\"rate_limit\":{\"primary_window\":{\"used_percent\":1,\"reset_at\":9223372036854775807}}}" }) |body| {
        try std.testing.expectError(error.InvalidUsageResponse, parse(std.testing.allocator, body));
    }
    const oversized = try std.testing.allocator.alloc(u8, max_body_bytes + 1);
    defer std.testing.allocator.free(oversized);
    try std.testing.expectError(error.UsageResponseTooLarge, parse(std.testing.allocator, oversized));
}

test "Codex usage reset dates fit desktop timestamps" {
    try std.testing.expectError(error.InvalidUsageResponse, parse(std.testing.allocator,
        \\{"rate_limit":{"primary_window":{"used_percent":1,"reset_at":8640000000001}}}
    ));
    const usage = try parse(std.testing.allocator,
        \\{"rate_limit":{"primary_window":{"used_percent":1,"reset_at":8640000000000}}}
    );
    try std.testing.expectEqual(@as(?i64, 8_640_000_000_000_000), usage.windows[0].resetsAt);
}

test "Codex usage transport uses only native OAuth and hides rejected bodies" {
    const Fake = struct {
        status: std.http.Status = .ok,
        failure: ?anyerror = null,
        fn execute(raw: ?*anyopaque, alloc: Allocator, request: oauth_transport.Request) !oauth_transport.Response {
            const self: *@This() = @ptrCast(@alignCast(raw.?));
            try std.testing.expectEqual(oauth_transport.Method.get, request.method);
            try std.testing.expectEqualStrings(usage_url, request.url);
            try std.testing.expectEqualStrings("Bearer fixture-token", request.authorization.?);
            try std.testing.expectEqualStrings("fixture-account", request.account_id.?);
            try std.testing.expect(request.deadline != null);
            if (self.failure) |err| return err;
            return .{ .disposition = if (self.status == .ok) .accepted else .rejected, .status = self.status, .body = try alloc.dupe(u8, if (self.status == .ok) "{}" else "private-upstream-body") };
        }
    };
    var fake = Fake{};
    var bounded = BoundedTransport{ .upstream = .{ .context = &fake, .execute_fn = Fake.execute }, .deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{ .clock = .awake, .raw = .fromMilliseconds(timeout_ms) }) };
    var token = "fixture-token".*;
    var account = "fixture-account".*;
    const access = chatgpt_oauth.Access{ .access_token = &token, .account_id = &account, .refresh_after_ms = 0 };
    _ = try fetch(std.testing.allocator, bounded.provider(), &access);
    for ([_]std.http.Status{ .unauthorized, .forbidden }) |status| {
        fake.status = status;
        try std.testing.expectError(error.UsageAuthFailed, fetch(std.testing.allocator, bounded.provider(), &access));
    }
    fake.status = .internal_server_error;
    try std.testing.expectError(error.UsageRejected, fetch(std.testing.allocator, bounded.provider(), &access));
    fake.failure = error.Timeout;
    try std.testing.expectError(error.Timeout, fetch(std.testing.allocator, bounded.provider(), &access));
    try std.testing.expectEqualStrings("Codex usage request timed out", errorMessage(error.Timeout));
    try std.testing.expectEqualStrings("Could not load Codex usage", errorMessage(error.PrivateUpstreamFailure));
    try std.testing.expectEqualStrings("Codex is not connected", errorMessage(error.UsageDisconnected));
}
