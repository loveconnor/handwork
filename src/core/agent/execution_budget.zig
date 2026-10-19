const std = @import("std");
const io_mod = @import("../shared/io.zig");

const Allocator = std.mem.Allocator;

pub const Environment = struct {
    max_children: ?[]const u8 = null,
    max_requests: ?[]const u8 = null,
    max_tokens: ?[]const u8 = null,
};

pub const Options = struct {
    max_children: ?usize = null,
    max_requests: ?u64 = null,
    max_tokens: ?u64 = null,

    pub fn parse(environment: Environment) ParseError!Options {
        return .{
            .max_children = try parseMaxChildren(environment.max_children),
            .max_requests = parseUnsigned(environment.max_requests) catch return error.InvalidMaxRequests,
            .max_tokens = parseUnsigned(environment.max_tokens) catch return error.InvalidMaxTokens,
        };
    }

    pub fn fromEnvironment() ParseError!Options {
        return parse(.{
            .max_children = io_mod.getenv("HANDWORK_EXPERIMENT_MAX_CHILDREN"),
            .max_requests = io_mod.getenv("HANDWORK_EXPERIMENT_MAX_REQUESTS"),
            .max_tokens = io_mod.getenv("HANDWORK_EXPERIMENT_MAX_TOKENS"),
        });
    }

    pub fn limits(self: Options) Limits {
        return .{ .max_requests = self.max_requests, .max_tokens = self.max_tokens };
    }
};

pub const ParseError = error{ InvalidMaxChildren, InvalidMaxRequests, InvalidMaxTokens };

pub fn parseMaxChildren(raw: ?[]const u8) error{InvalidMaxChildren}!?usize {
    const value = parseUnsigned(raw) catch return error.InvalidMaxChildren;
    return if (value) |count| std.math.cast(usize, count) orelse error.InvalidMaxChildren else null;
}

fn parseUnsigned(raw: ?[]const u8) error{InvalidLimit}!?u64 {
    const text = raw orelse return null;
    if (text.len == 0) return error.InvalidLimit;
    for (text) |byte| if (byte < '0' or byte > '9') return error.InvalidLimit;
    return std.fmt.parseInt(u64, text, 10) catch error.InvalidLimit;
}

pub const Limits = struct {
    max_requests: ?u64 = null,
    max_tokens: ?u64 = null,
};

/// Provider-reported input and output totals, not UI progress estimates. Missing
/// either count leaves the aggregate incomplete. Do not add cache or reasoning
/// subcounts to these totals a second time.
pub const TokenUsage = struct {
    input_tokens: ?u64 = null,
    output_tokens: ?u64 = null,
};

pub const Settlement = union(enum) {
    usage: TokenUsage,
    /// Delivery was proven unbilled. The admitted request still counts.
    unbilled,
    /// Possibly sent failure or provider token counts not yet known.
    unknown,
};

pub const Snapshot = struct {
    admitted_requests: u64,
    known_tokens: u64,
    in_flight: usize,
    unknown_requests: u64,
    token_count_overflowed: bool,
};

pub const AdmissionError = Allocator.Error || error{
    Cancelled,
    ExecutionBudgetRequestsExceeded,
    ExecutionBudgetTokensExceeded,
    ExecutionBudgetUsageUnknown,
    ExecutionBudgetUsagePending,
    ExecutionBudgetCounterOverflow,
};

pub const Ticket = struct {
    owner: *Budget,
    id: u64,
};

/// One root execution and all its children borrow the same stable-address Budget.
/// The root must drain all provider calls before deinit. Never copy a live Budget.
/// This is an admission limit, not a provider billing ledger or durable session
/// history. Recovered sessions need an explicit restored budget or a new window.
///
/// Requests are charged at admission, including retries and failures, and never
/// refunded. Token-limited calls serialize admission while usage is pending.
/// Unknown usage blocks future calls for this window. An already admitted call
/// can exceed the remaining token allowance; this is not an exact hard token cap.
/// Neither cancellation nor an accounting error can undo provider delivery.
pub const Budget = struct {
    allocator: Allocator,
    limits: Limits,
    mutex: std.Io.Mutex = .init,
    active: std.ArrayList(u64) = .empty,
    admitted_requests: u64 = 0,
    known_tokens: u64 = 0,
    unknown_requests: u64 = 0,
    token_count_overflowed: bool = false,

    pub fn init(allocator: Allocator, limits: Limits) Budget {
        return .{ .allocator = allocator, .limits = limits };
    }

    pub fn deinit(self: *Budget) void {
        std.debug.assert(self.active.items.len == 0);
        self.active.deinit(self.allocator);
        self.* = undefined;
    }

    /// Call exactly at the provider's pre-delivery admission hook, after request
    /// validation. A replay of an existing child result must not call this; an
    /// actual authentication or recovery provider replay must acquire a new ticket.
    /// No I/O, provider callbacks, or usage-ledger locks run under this mutex.
    pub fn beginRequest(self: *Budget, cancel_flag: *const std.atomic.Value(bool)) AdmissionError!Ticket {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (cancel_flag.load(.seq_cst)) return error.Cancelled;
        if (self.limits.max_requests) |limit| {
            if (self.admitted_requests >= limit) return error.ExecutionBudgetRequestsExceeded;
        }
        if (self.limits.max_tokens) |limit| {
            if (self.known_tokens >= limit or self.token_count_overflowed) return error.ExecutionBudgetTokensExceeded;
            if (self.unknown_requests != 0) return error.ExecutionBudgetUsageUnknown;
            if (self.active.items.len != 0) return error.ExecutionBudgetUsagePending;
        }
        if (self.admitted_requests == std.math.maxInt(u64)) return error.ExecutionBudgetCounterOverflow;
        try self.active.ensureUnusedCapacity(self.allocator, 1);
        self.admitted_requests += 1;
        self.active.appendAssumeCapacity(self.admitted_requests);
        return .{ .owner = self, .id = self.admitted_requests };
    }

    /// Settle on every admitted exit, even when durable usage publication fails.
    /// Missing token counts remain conservative for this execution window;
    /// asynchronous billing reconciliation must not subtract or double-charge it.
    /// A copied or repeated ticket is rejected without changing any counters.
    pub fn finishRequest(self: *Budget, ticket: Ticket, settlement: Settlement) error{InvalidBudgetTicket}!void {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (ticket.owner != self) return error.InvalidBudgetTicket;
        const index = std.mem.findScalar(u64, self.active.items, ticket.id) orelse return error.InvalidBudgetTicket;
        _ = self.active.swapRemove(index);
        switch (settlement) {
            .unbilled => {},
            .unknown => self.unknown_requests +|= 1,
            .usage => |usage| {
                self.addTokens(usage.input_tokens orelse 0);
                self.addTokens(usage.output_tokens orelse 0);
                if (usage.input_tokens == null or usage.output_tokens == null) self.unknown_requests +|= 1;
            },
        }
    }

    fn addTokens(self: *Budget, count: u64) void {
        const total = @addWithOverflow(self.known_tokens, count);
        if (total[1] != 0) self.token_count_overflowed = true;
        self.known_tokens +|= count;
    }

    pub fn snapshot(self: *Budget) Snapshot {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        return .{
            .admitted_requests = self.admitted_requests,
            .known_tokens = self.known_tokens,
            .in_flight = self.active.items.len,
            .unknown_requests = self.unknown_requests,
            .token_count_overflowed = self.token_count_overflowed,
        };
    }
};

test "execution budget environment limits are opt in and strictly decimal" {
    try std.testing.expectEqual(Options{}, try Options.parse(.{}));
    const zero = try Options.parse(.{ .max_children = "0", .max_requests = "0", .max_tokens = "0" });
    try std.testing.expectEqual(@as(?usize, 0), zero.max_children);
    try std.testing.expectEqual(@as(?u64, 0), zero.max_requests);
    try std.testing.expectEqual(@as(?u64, 0), zero.max_tokens);
    const valid = try Options.parse(.{ .max_children = "2", .max_requests = "12", .max_tokens = "18446744073709551615" });
    try std.testing.expectEqual(@as(?usize, 2), valid.max_children);
    try std.testing.expectEqual(@as(?u64, 12), valid.max_requests);
    try std.testing.expectEqual(@as(?u64, std.math.maxInt(u64)), valid.max_tokens);
    for ([_][]const u8{ "", "-1", "+1", " 1", "1 ", "1\n", "1_000", "0x10", "1.5", "18446744073709551616" }) |raw| {
        try std.testing.expectError(error.InvalidMaxChildren, Options.parse(.{ .max_children = raw }));
        try std.testing.expectError(error.InvalidMaxRequests, Options.parse(.{ .max_requests = raw }));
        try std.testing.expectError(error.InvalidMaxTokens, Options.parse(.{ .max_tokens = raw }));
    }
}

test "execution budget shares admitted request capacity across parent children retries and failures" {
    var budget = Budget.init(std.testing.allocator, .{ .max_requests = 2 });
    defer budget.deinit();
    const cancel = std.atomic.Value(bool).init(false);
    const parent = try budget.beginRequest(&cancel);
    const child = try budget.beginRequest(&cancel);
    try std.testing.expectEqual(@as(usize, 2), budget.snapshot().in_flight);
    try std.testing.expectError(error.ExecutionBudgetRequestsExceeded, budget.beginRequest(&cancel));
    try budget.finishRequest(parent, .unbilled);
    try budget.finishRequest(child, .unknown);
    try std.testing.expectError(error.ExecutionBudgetRequestsExceeded, budget.beginRequest(&cancel));
    try std.testing.expectEqual(@as(u64, 2), budget.snapshot().admitted_requests);
    try std.testing.expectEqual(@as(u64, 1), budget.snapshot().unknown_requests);
}

test "execution budget token admission waits for usage and exposes single request overshoot" {
    var budget = Budget.init(std.testing.allocator, .{ .max_tokens = 10 });
    defer budget.deinit();
    const cancel = std.atomic.Value(bool).init(false);
    const first = try budget.beginRequest(&cancel);
    try std.testing.expectError(error.ExecutionBudgetUsagePending, budget.beginRequest(&cancel));
    try budget.finishRequest(first, .{ .usage = .{ .input_tokens = 3, .output_tokens = 2 } });
    const second = try budget.beginRequest(&cancel);
    try budget.finishRequest(second, .{ .usage = .{ .input_tokens = 4, .output_tokens = 6 } });
    try std.testing.expectEqual(@as(u64, 15), budget.snapshot().known_tokens);
    try std.testing.expectError(error.ExecutionBudgetTokensExceeded, budget.beginRequest(&cancel));
}

test "execution budget missing or partial usage blocks future token requests" {
    for ([_]Settlement{ .unknown, .{ .usage = .{} }, .{ .usage = .{ .input_tokens = 7 } }, .{ .usage = .{ .output_tokens = 4 } } }) |settlement| {
        var budget = Budget.init(std.testing.allocator, .{ .max_tokens = 100 });
        defer budget.deinit();
        const cancel = std.atomic.Value(bool).init(false);
        const ticket = try budget.beginRequest(&cancel);
        try budget.finishRequest(ticket, settlement);
        try std.testing.expectEqual(@as(u64, 1), budget.snapshot().unknown_requests);
        try std.testing.expectError(error.ExecutionBudgetUsageUnknown, budget.beginRequest(&cancel));
    }
}

test "execution budget cancellation and replay cannot refund or double settle admission" {
    var budget = Budget.init(std.testing.allocator, .{ .max_tokens = 100 });
    defer budget.deinit();
    var other = Budget.init(std.testing.allocator, .{});
    defer other.deinit();
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.Cancelled, budget.beginRequest(&cancel));
    try std.testing.expectEqual(@as(u64, 0), budget.snapshot().admitted_requests);
    cancel.store(false, .seq_cst);
    const ticket = try budget.beginRequest(&cancel);
    try std.testing.expectError(error.InvalidBudgetTicket, other.finishRequest(ticket, .unbilled));
    cancel.store(true, .seq_cst);
    try budget.finishRequest(ticket, .unknown);
    try std.testing.expectError(error.InvalidBudgetTicket, budget.finishRequest(ticket, .{ .usage = .{ .input_tokens = 1, .output_tokens = 1 } }));
    try std.testing.expectEqual(@as(u64, 1), budget.snapshot().admitted_requests);
    try std.testing.expectEqual(@as(u64, 0), budget.snapshot().known_tokens);
    try std.testing.expectEqual(@as(usize, 0), budget.snapshot().in_flight);
}

test "execution budget unlimited defaults allow concurrent requests despite unknown usage" {
    var budget = Budget.init(std.testing.allocator, .{});
    defer budget.deinit();
    const cancel = std.atomic.Value(bool).init(false);
    const first = try budget.beginRequest(&cancel);
    const second = try budget.beginRequest(&cancel);
    try budget.finishRequest(first, .unknown);
    const third = try budget.beginRequest(&cancel);
    try budget.finishRequest(second, .unbilled);
    try budget.finishRequest(third, .unbilled);
    try std.testing.expectEqual(@as(u64, 3), budget.snapshot().admitted_requests);
}

test "execution budget zero limits block admission and token arithmetic saturates" {
    const cancel = std.atomic.Value(bool).init(false);
    for ([_]Limits{ .{ .max_requests = 0 }, .{ .max_tokens = 0 } }) |limits| {
        var budget = Budget.init(std.testing.allocator, limits);
        defer budget.deinit();
        const expected = if (limits.max_requests != null) error.ExecutionBudgetRequestsExceeded else error.ExecutionBudgetTokensExceeded;
        try std.testing.expectError(expected, budget.beginRequest(&cancel));
    }
    var budget = Budget.init(std.testing.allocator, .{ .max_tokens = std.math.maxInt(u64) });
    defer budget.deinit();
    const ticket = try budget.beginRequest(&cancel);
    try budget.finishRequest(ticket, .{ .usage = .{ .input_tokens = std.math.maxInt(u64), .output_tokens = 1 } });
    try std.testing.expect(budget.snapshot().token_count_overflowed);
    try std.testing.expectEqual(std.math.maxInt(u64), budget.snapshot().known_tokens);
    try std.testing.expectError(error.ExecutionBudgetTokensExceeded, budget.beginRequest(&cancel));
}

test "execution budget allocation failure does not consume admission" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn check(allocator: Allocator) !void {
            var budget = Budget.init(allocator, .{ .max_requests = 1 });
            defer budget.deinit();
            const cancel = std.atomic.Value(bool).init(false);
            const ticket = budget.beginRequest(&cancel) catch |err| {
                try std.testing.expectEqual(@as(u64, 0), budget.snapshot().admitted_requests);
                try std.testing.expectEqual(@as(usize, 0), budget.snapshot().in_flight);
                return err;
            };
            try budget.finishRequest(ticket, .unbilled);
            try std.testing.expectEqual(@as(u64, 1), budget.snapshot().admitted_requests);
        }
    }.check, .{});
}

test "execution budget concurrent callers cannot over admit the shared request limit" {
    const Fixture = struct {
        budget: *Budget,
        admitted: *std.atomic.Value(usize),
        failed: *std.atomic.Value(bool),

        fn run(self: @This()) void {
            const cancel = std.atomic.Value(bool).init(false);
            const ticket = self.budget.beginRequest(&cancel) catch |err| {
                if (err != error.ExecutionBudgetRequestsExceeded) self.failed.store(true, .seq_cst);
                return;
            };
            _ = self.admitted.fetchAdd(1, .seq_cst);
            self.budget.finishRequest(ticket, .unbilled) catch self.failed.store(true, .seq_cst);
        }
    };
    var budget = Budget.init(std.testing.allocator, .{ .max_requests = 3 });
    defer budget.deinit();
    var admitted = std.atomic.Value(usize).init(0);
    var failed = std.atomic.Value(bool).init(false);
    var threads: [8]std.Thread = undefined;
    var started: usize = 0;
    defer for (threads[0..started]) |thread| thread.join();
    for (&threads) |*thread| {
        thread.* = try std.Thread.spawn(.{}, Fixture.run, .{Fixture{ .budget = &budget, .admitted = &admitted, .failed = &failed }});
        started += 1;
    }
    for (threads[0..started]) |thread| thread.join();
    started = 0;
    try std.testing.expect(!failed.load(.seq_cst));
    try std.testing.expectEqual(@as(usize, 3), admitted.load(.seq_cst));
    try std.testing.expectEqual(@as(u64, 3), budget.snapshot().admitted_requests);
    try std.testing.expectEqual(@as(usize, 0), budget.snapshot().in_flight);
}
