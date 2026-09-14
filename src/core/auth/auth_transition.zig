const std = @import("std");
const credentials = @import("credentials.zig");
const model_provider = @import("../config/model_provider.zig");

pub const ProviderSwitchDecision = enum {
    no_change,
    busy,
    prepare,
};

pub const ProviderSwitchIntent = enum {
    manual,
    post_oauth,
};

pub const ProviderSwitchFacts = struct {
    current: model_provider.ProviderId,
    target: model_provider.ProviderId,
    target_credential_ready: bool,
    intent: ProviderSwitchIntent,
    stream_active: bool,
    queued_prompts: usize,
};

pub fn provider_work_busy(stream_active: bool, queued_prompts: usize) bool {
    return stream_active or queued_prompts > 0;
}

pub fn decideProviderSwitch(facts: ProviderSwitchFacts) ProviderSwitchDecision {
    if (facts.intent == .manual and facts.current == facts.target and facts.target_credential_ready) {
        return .no_change;
    }
    if (provider_work_busy(facts.stream_active, facts.queued_prompts)) return .busy;
    return .prepare;
}

pub const LogoutFacts = struct {
    requested: ?model_provider.ProviderId,
    selected: model_provider.ProviderId,
    active_source: ?credentials.Source,
    available_sources: std.EnumSet(credentials.Source),
};

pub fn decideLogoutProvider(facts: LogoutFacts) model_provider.ProviderId {
    return facts.requested orelse facts.selected;
}

pub fn logoutFallbackProviders(facts: LogoutFacts) [2]?model_provider.ProviderId {
    var candidates: [2]?model_provider.ProviderId = .{ null, null };
    const removed = decideLogoutProvider(facts);
    if (removed != facts.selected) return candidates;

    var count: usize = 0;
    for ([_]model_provider.ProviderId{ .codex, .grok }) |provider| {
        if (provider == removed) continue;
        const available = switch (provider) {
            .codex => facts.available_sources.contains(.chatgpt_subscription),
            .grok => facts.available_sources.contains(.grok_subscription),
            else => false,
        };
        if (!available) continue;
        candidates[count] = provider;
        count += 1;
    }
    return candidates;
}

test "logout fallback selects only the remaining subscription" {
    const candidates = logoutFallbackProviders(.{
        .requested = .codex,
        .selected = .codex,
        .active_source = .chatgpt_subscription,
        .available_sources = .initMany(&.{ .chatgpt_subscription, .grok_subscription }),
    });
    try std.testing.expectEqual([2]?model_provider.ProviderId{ .grok, null }, candidates);
}

test "logout fallback excludes inactive removal and disconnected providers" {
    var facts: LogoutFacts = .{
        .requested = .codex,
        .selected = .grok,
        .active_source = .grok_subscription,
        .available_sources = .initOne(.grok_subscription),
    };
    try std.testing.expectEqual([2]?model_provider.ProviderId{ null, null }, logoutFallbackProviders(facts));
    facts.selected = .codex;
    facts.available_sources = .initOne(.grok_subscription);
    try std.testing.expectEqual([2]?model_provider.ProviderId{ .grok, null }, logoutFallbackProviders(facts));
    facts.available_sources = .empty;
    try std.testing.expectEqual([2]?model_provider.ProviderId{ null, null }, logoutFallbackProviders(facts));
}

pub const SignInCompletionAction = union(enum) {
    switch_provider: model_provider.ProviderId,
    activate_source: credentials.Source,
};

pub fn signInCompletion(
    provider: model_provider.ProviderId,
    provider_routing_supported: bool,
) SignInCompletionAction {
    return switch (provider) {
        .codex => if (provider_routing_supported)
            .{ .switch_provider = .codex }
        else
            .{ .activate_source = .chatgpt_subscription },
        .grok => if (provider_routing_supported)
            .{ .switch_provider = .grok }
        else
            .{ .activate_source = .grok_subscription },
        else => .{ .switch_provider = provider },
    };
}

pub const CredentialAuthorityFacts = struct {
    provider: model_provider.ProviderId,
    source: credentials.Source,
    account_id: ?[]const u8,
};

pub const CredentialChange = enum {
    none,
    secret_only,
    authority,
};

pub fn decideCredentialChange(
    current: CredentialAuthorityFacts,
    candidate: CredentialAuthorityFacts,
    secret_changed: bool,
) CredentialChange {
    if (current.provider != candidate.provider or
        current.source != candidate.source or
        !optionalBytesEqual(current.account_id, candidate.account_id))
    {
        return .authority;
    }
    return if (secret_changed) .secret_only else .none;
}

pub const AuthReplayFacts = struct {
    authentication_rejected: bool,
    refreshable: bool,
    delivery_safe: bool,
    already_replayed: bool,
};

pub const AuthReplayDecision = enum {
    fail,
    refresh_and_replay,
};

pub fn decideAuthReplay(facts: AuthReplayFacts) AuthReplayDecision {
    if (!facts.authentication_rejected or
        !facts.refreshable or
        !facts.delivery_safe or
        facts.already_replayed)
    {
        return .fail;
    }
    return .refresh_and_replay;
}

fn optionalBytesEqual(left: ?[]const u8, right: ?[]const u8) bool {
    if (left == null or right == null) return left == null and right == null;
    return std.mem.eql(u8, left.?, right.?);
}

test "provider switch and logout decisions are pure and provider keyed" {
    try std.testing.expectEqual(ProviderSwitchDecision.no_change, decideProviderSwitch(.{
        .current = .codex,
        .target = .codex,
        .target_credential_ready = true,
        .intent = .manual,
        .stream_active = false,
        .queued_prompts = 0,
    }));
    try std.testing.expectEqual(ProviderSwitchDecision.busy, decideProviderSwitch(.{
        .current = .codex,
        .target = .grok,
        .target_credential_ready = true,
        .intent = .manual,
        .stream_active = true,
        .queued_prompts = 0,
    }));

    var inventory: std.EnumSet(credentials.Source) = .empty;
    inventory.insert(.chatgpt_subscription);
    try std.testing.expectEqual(model_provider.ProviderId.codex, decideLogoutProvider(.{
        .requested = null,
        .selected = .codex,
        .active_source = null,
        .available_sources = inventory,
    }));
    try std.testing.expectEqual(model_provider.ProviderId.grok, decideLogoutProvider(.{
        .requested = .grok,
        .selected = .codex,
        .active_source = .chatgpt_subscription,
        .available_sources = inventory,
    }));
}

test "sign in completion selects routing or credential activation without effects" {
    try std.testing.expectEqual(
        SignInCompletionAction{ .switch_provider = .codex },
        signInCompletion(.codex, true),
    );
    try std.testing.expectEqual(
        SignInCompletionAction{ .activate_source = .grok_subscription },
        signInCompletion(.grok, false),
    );
}

test "credential change distinguishes secret rotation from authority replacement" {
    const stable = CredentialAuthorityFacts{
        .provider = .codex,
        .source = .chatgpt_subscription,
        .account_id = null,
    };
    try std.testing.expectEqual(
        CredentialChange.none,
        decideCredentialChange(stable, stable, false),
    );
    try std.testing.expectEqual(
        CredentialChange.secret_only,
        decideCredentialChange(stable, stable, true),
    );
    try std.testing.expectEqual(
        CredentialChange.authority,
        decideCredentialChange(stable, .{
            .provider = .codex,
            .source = .chatgpt_subscription,
            .account_id = "acct_other",
        }, true),
    );
    try std.testing.expectEqual(
        CredentialChange.authority,
        decideCredentialChange(.{
            .provider = .codex,
            .source = .chatgpt_subscription,
            .account_id = "acct_1",
        }, .{
            .provider = .codex,
            .source = .chatgpt_subscription,
            .account_id = "acct_2",
        }, true),
    );
}

test "auth replay is one delivery-safe refresh outside semantic policy" {
    const eligible = AuthReplayFacts{
        .authentication_rejected = true,
        .refreshable = true,
        .delivery_safe = true,
        .already_replayed = false,
    };
    try std.testing.expectEqual(AuthReplayDecision.refresh_and_replay, decideAuthReplay(eligible));

    var blocked = eligible;
    blocked.already_replayed = true;
    try std.testing.expectEqual(AuthReplayDecision.fail, decideAuthReplay(blocked));
    blocked = eligible;
    blocked.delivery_safe = false;
    try std.testing.expectEqual(AuthReplayDecision.fail, decideAuthReplay(blocked));
}
