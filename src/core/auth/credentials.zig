const std = @import("std");
const api_providers = @import("../config/api_providers.zig");
const io_mod = @import("../shared/io.zig");
const chatgpt_oauth = @import("chatgpt_oauth.zig");
const chatgpt_session = @import("chatgpt_session.zig");
const grok_oauth = @import("grok_oauth.zig");
const grok_session = @import("grok_session.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const host = @import("../hosts/host.zig");
const model_provider = @import("../config/model_provider.zig");
const provider_catalog = @import("provider_catalog.zig");
const oauth_transport = @import("oauth_transport.zig");
const secret = @import("secret.zig");
const types = @import("../shared/types.zig");

pub const Source = types.CredentialSource;

pub const AuthMode = enum {
    local,
    host_managed,
};

pub const AuthModeError = error{InvalidAuthMode};

pub fn parseAuthMode(value: ?[]const u8) AuthModeError!AuthMode {
    const raw = value orelse return .local;
    if (std.mem.eql(u8, raw, "local")) return .local;
    if (std.mem.eql(u8, raw, "host-managed")) return .host_managed;
    return error.InvalidAuthMode;
}

pub const CatalogPublicOnly = union(enum) {
    no_credential,

    credential_refresh_required: Source,
    credential_refresh_failed: Source,
    authenticated_credential_rejected: Source,
    chatgpt_subscription,
    grok_subscription,

    fn credentialSource(self: CatalogPublicOnly) ?Source {
        return switch (self) {
            .no_credential => null,

            .credential_refresh_required => |source| source,
            .credential_refresh_failed => |source| source,
            .authenticated_credential_rejected => |source| source,
            .chatgpt_subscription => .chatgpt_subscription,
            .grok_subscription => .grok_subscription,
        };
    }
};

pub const CatalogPublicOnlyReason = std.meta.Tag(CatalogPublicOnly);

pub const CatalogAuthenticatedSource = Source;

/// A borrowed authorization decision for one model-catalog request. Public-only
/// states cannot carry credential bytes; authenticated states carry the
/// only values the request is allowed to send.
pub const CatalogAccess = union(enum) {
    public_only: CatalogPublicOnly,
    authenticated: struct {
        source: CatalogAuthenticatedSource,
        credential: []const u8,

        account_id: ?[]const u8 = null,
    },
    host_managed,

    pub fn credentialSource(self: CatalogAccess) ?Source {
        return switch (self) {
            .public_only => |access| access.credentialSource(),
            .authenticated => |access| access.source,
            .host_managed => .host_managed,
        };
    }

    pub fn publicOnlyReason(self: CatalogAccess) ?CatalogPublicOnlyReason {
        const access = self.publicOnly() orelse return null;
        return std.meta.activeTag(access);
    }

    pub fn publicOnly(self: CatalogAccess) ?CatalogPublicOnly {
        return switch (self) {
            .public_only => |access| access,
            .authenticated, .host_managed => null,
        };
    }

    pub fn authorizationCredential(self: CatalogAccess) ?[]const u8 {
        return switch (self) {
            .public_only => null,
            .authenticated => |access| access.credential,
            .host_managed => null,
        };
    }

    pub fn accountId(self: CatalogAccess) ?[]const u8 {
        const account_id = switch (self) {
            .public_only => return null,
            .authenticated => |access| access.account_id orelse return null,
            .host_managed => return null,
        };
        return if (account_id.len > 0) account_id else null;
    }
};

pub fn catalogAccessAt(credential: ?Credential, now_ms: i64) CatalogAccess {
    const selected = credential orelse return .{ .public_only = .no_credential };
    if (sourceRefreshable(selected.source) and selected.needsRefreshAt(now_ms)) {
        return .{ .public_only = .{ .credential_refresh_required = selected.source } };
    }
    return catalogAccessForCredentialAndAccount(
        selected.source,
        selected.token,

        selected.accountId(),
    );
}

pub fn catalogAccessAfterRefreshFailure(source: Source) CatalogAccess {
    return .{
        .public_only = .{
            .credential_refresh_failed = source,
        },
    };
}

pub fn catalogAccessForCredential(
    source: ?Source,
    credential: []const u8,
) CatalogAccess {
    return catalogAccessForCredentialAndAccount(source, credential, null);
}

pub fn catalogAccessForCredentialAndAccount(
    source: ?Source,
    credential: []const u8,
    account_id: ?[]const u8,
) CatalogAccess {
    const selected_source = source orelse return .{ .public_only = .no_credential };
    if (selected_source == .host_managed) return .host_managed;
    const authenticated_source: CatalogAuthenticatedSource = switch (selected_source) {
        .chatgpt_subscription => .chatgpt_subscription,
        .grok_subscription => .grok_subscription,
        else => selected_source,
    };
    return .{
        .authenticated = .{
            .source = authenticated_source,
            .credential = credential,

            .account_id = account_id,
        },
    };
}

/// Both modes resolve the same source set; the mode selects only whether an expired
/// subscription session is refreshed first.
pub const LoadMode = enum { stored, refresh_if_needed };

pub const missing_credential_message = "handwork needs a subscription login. Run handwork login codex or handwork login grok.";
pub const missing_interactive_credential_message = "handwork needs a subscription login. Run /provider and choose Codex or Grok.";
pub const missing_chatgpt_credential_message = "handwork needs a Codex subscription login for this model. Run handwork login codex.";
pub const missing_chatgpt_interactive_credential_message = "Codex needs a subscription login. Run /provider and choose Codex.";
pub const missing_grok_credential_message = "handwork needs a Grok subscription login for this model. Run handwork login grok.";
pub const missing_grok_interactive_credential_message = "Grok needs a subscription login. Run /provider and choose Grok.";

pub const host_managed_auth_message = "Authentication is managed by the host.";

test "auth mode accepts only local and host-managed process values" {
    try std.testing.expectEqual(AuthMode.local, try parseAuthMode(null));
    try std.testing.expectEqual(AuthMode.local, try parseAuthMode("local"));
    try std.testing.expectEqual(AuthMode.host_managed, try parseAuthMode("host-managed"));
    try std.testing.expectError(error.InvalidAuthMode, parseAuthMode("host_managed"));
    try std.testing.expectError(error.InvalidAuthMode, parseAuthMode(""));
}

pub const Credential = struct {
    token: []u8,
    source: Source,
    account_id: ?[]u8 = null,

    refresh_after_ms: ?i64 = null,

    pub fn clone(self: Credential, alloc: std.mem.Allocator) !Credential {
        const token = try alloc.dupe(u8, self.token);
        errdefer secret.zeroAndFree(alloc, token);
        const account_id = if (self.account_id) |value| try alloc.dupe(u8, value) else null;
        errdefer if (account_id) |value| alloc.free(value);

        return .{
            .token = token,
            .source = self.source,
            .account_id = account_id,

            .refresh_after_ms = self.refresh_after_ms,
        };
    }

    pub fn deinit(self: *Credential, alloc: std.mem.Allocator) void {
        secret.zeroAndFree(alloc, self.token);
        if (self.account_id) |account_id| alloc.free(account_id);

        self.* = undefined;
    }

    pub fn accountId(self: Credential) ?[]const u8 {
        return self.account_id;
    }

    pub fn needsRefreshAt(self: Credential, now_ms: i64) bool {
        const refresh_after_ms = self.refresh_after_ms orelse return false;
        return refresh_after_ms <= now_ms;
    }
};

/// The selected subscription could not be loaded or refreshed.
pub const LoadFailure = struct {
    source: Source,
    err: anyerror,
};

pub const Resolution = struct {
    credential: ?Credential = null,

    failure: ?LoadFailure = null,
};

/// Resolve the preferred subscription, defaulting to Codex.
pub fn resolve(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
) !Resolution {
    return resolvePreferring(alloc, transport, secret_store, mode, null);
}

pub fn resolveForProvider(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
    provider: model_provider.ProviderId,
    preferred: ?Source,
) !Resolution {
    _ = preferred;
    if (!@import("../config/provider_policy.zig").nativeEnabled(provider)) return .{};
    const source = provider_catalog.find(provider).login_source;
    const credential = loadPreferredSource(alloc, transport, secret_store, mode, source) catch |err| {
        if (err == error.OutOfMemory) return err;
        debug_trace.logf("auth", "provider source load failed source={t} err={s}", .{ source, @errorName(err) });
        return .{ .failure = .{ .source = source, .err = err } };
    };
    return .{ .credential = credential };
}

/// `preferred` is the source the user last chose in the hub. It is an exact
/// authority choice, not a precedence hint: absence or refresh failure must not
/// silently select a different billing or account boundary. Only null
/// defaults to the Codex subscription.
pub fn resolvePreferring(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
    preferred: ?Source,
) !Resolution {
    const source = preferred orelse .chatgpt_subscription;
    if (source == .host_managed) return error.UnsupportedCredentialSource;
    const credential = loadPreferredSource(alloc, transport, secret_store, mode, source) catch |err| {
        if (err == error.OutOfMemory) return err;
        return .{ .failure = .{ .source = source, .err = err } };
    };
    return .{ .credential = credential };
}

/// `loadSource` refreshes an expired subscription, which `.stored` mode
/// forbids: a diagnostic must not rewrite the session file or make an OAuth
/// request. Honour the mode for the preferred source too.
fn loadPreferredSource(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
    source: Source,
) !?Credential {
    if (source == .grok_subscription) return null;
    return switch (source) {
        .chatgpt_subscription => switch (mode) {
            .stored => loadStoredChatGptCredential(alloc),
            .refresh_if_needed => loadChatGptCredential(alloc, transport, .if_needed),
        },
        .grok_subscription => switch (mode) {
            .stored => loadStoredGrokCredential(alloc),
            .refresh_if_needed => loadGrokCredential(alloc, transport, .if_needed),
        },
        else => loadSource(alloc, transport, secret_store, source),
    };
}

pub fn loadSource(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    source: Source,
) !?Credential {
    _ = secret_store;
    if (source == .grok_subscription) return null;
    return switch (source) {
        .chatgpt_subscription => loadChatGptCredential(alloc, transport, .if_needed),
        .grok_subscription => loadGrokCredential(alloc, transport, .if_needed),
        .host_managed => null,
        else => loadApiKey(alloc, source),
    };
}

pub fn loadApiKey(alloc: std.mem.Allocator, source: Source) !?Credential {
    const entry = api_providers.forSource(source) orelse return null;
    if (!@import("../config/provider_policy.zig").nativeEnabled(entry.id)) return null;
    const saved = if (entry.anonymous) null else try @import("api_key_store.zig").load(alloc, entry.id);
    defer if (saved) |bytes| secret.zeroAndFree(alloc, bytes);
    const key = saved orelse if (entry.anonymous) @tagName(entry.id) else io_mod.getenv(entry.key_env) orelse return null;
    if (!api_providers.validProviderKey(entry.id, key)) return error.InvalidApiKey;
    const token = try alloc.dupe(u8, key);
    errdefer secret.zeroAndFree(alloc, token);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(key, &digest, .{});
    const fingerprint = std.fmt.bytesToHex(digest, .lower);
    return .{ .token = token, .source = source, .account_id = try alloc.dupe(u8, &fingerprint) };
}

pub fn sourceExists(
    alloc: std.mem.Allocator,
    secret_store: host.SecretStore,
    source: Source,
) !bool {
    _ = secret_store;
    try requireSourceStorage(source);
    if (source == .grok_subscription) return false;
    return switch (source) {
        .chatgpt_subscription => chatgpt_oauth.sourceExists(alloc),
        .grok_subscription => grok_oauth.sourceExists(alloc),
        else => blk: {
            var key = try loadApiKey(alloc, source) orelse break :blk false;
            key.deinit(alloc);
            break :blk true;
        },
    };
}

pub fn sourcePresence(
    secret_store: host.SecretStore,
    source: Source,
) host.SecretStorePresence {
    _ = secret_store;
    if (source == .grok_subscription) return .missing;
    return switch (source) {
        .chatgpt_subscription => chatgpt_session.presence(),
        .grok_subscription => grok_session.presence(),
        else => blk: {
            var key = (loadApiKey(std.heap.page_allocator, source) catch break :blk .unavailable) orelse break :blk .missing;
            key.deinit(std.heap.page_allocator);
            break :blk .present;
        },
    };
}

/// Shared admission for reading a saved OAuth credential.
pub fn requireSourceStorage(source: Source) error{CredentialStorageUnavailable}!void {
    if (!sourceRefreshable(source)) return;
    if (sourcePresence(host.unavailable_secret_store, source) == .unavailable) {
        debug_trace.logf("auth", "credential storage unavailable source={t}", .{source});
        return error.CredentialStorageUnavailable;
    }
}

pub fn requireSignInStorage(source: Source) error{CredentialStorageUnavailable}!void {
    switch (source) {
        .chatgpt_subscription => try chatgpt_session.requireSignInStorage(),
        .grok_subscription => try grok_session.requireSignInStorage(),
        else => {},
    }
}

fn loadChatGptCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: chatgpt_oauth.RefreshMode,
) !?Credential {
    try requireSourceStorage(.chatgpt_subscription);
    var access = (try chatgpt_oauth.loadAccess(alloc, transport, mode)) orelse return null;
    defer access.deinit(alloc);
    const token = access.access_token;
    access.access_token = &.{};
    const account_id = access.account_id;
    access.account_id = &.{};
    return .{
        .token = token,
        .source = .chatgpt_subscription,
        .account_id = account_id,
        .refresh_after_ms = access.refresh_after_ms,
    };
}

fn loadStoredChatGptCredential(alloc: std.mem.Allocator) !?Credential {
    return loadChatGptCredential(alloc, oauth_transport.unavailable_provider, .stored);
}

fn loadGrokCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: grok_oauth.RefreshMode,
) !?Credential {
    try requireSourceStorage(.grok_subscription);
    var access = (try grok_oauth.loadAccess(alloc, transport, mode)) orelse return null;
    defer access.deinit(alloc);
    const token = access.access_token;
    access.access_token = &.{};
    const account_id = access.account_id;
    access.account_id = &.{};
    return .{
        .token = token,
        .source = .grok_subscription,
        .account_id = account_id,
        .refresh_after_ms = access.refresh_after_ms,
    };
}

fn loadStoredGrokCredential(alloc: std.mem.Allocator) !?Credential {
    return loadGrokCredential(alloc, oauth_transport.unavailable_provider, .stored);
}

pub fn refreshChatGptCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
) !?Credential {
    return loadChatGptCredential(alloc, transport, .force);
}

pub fn refreshGrokCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
) !?Credential {
    return loadGrokCredential(alloc, transport, .force);
}

pub fn sourceLabel(source: Source) []const u8 {
    return switch (source) {
        .chatgpt_subscription => "Codex subscription",
        .grok_subscription => "Grok subscription",
        .host_managed => "host managed",
        .ollama_local => "Ollama Local (no key)",
        .opencode_local => "OpenCode Local (no key)",
        else => api_providers.forSource(source).?.key_env,
    };
}

pub fn sourceRefreshable(source: Source) bool {
    return source == .chatgpt_subscription or source == .grok_subscription;
}

test "subscription catalog access never sends refresh-due credentials" {
    for ([_]Source{ .chatgpt_subscription, .grok_subscription }) |source| {
        var credential = Credential{
            .token = try std.testing.allocator.dupe(u8, "expired-subscription-token"),
            .source = source,
            .account_id = try std.testing.allocator.dupe(u8, "acct_123"),
            .refresh_after_ms = 10,
        };
        defer credential.deinit(std.testing.allocator);

        const access = catalogAccessAt(credential, 10);
        try std.testing.expectEqual(
            CatalogPublicOnlyReason.credential_refresh_required,
            access.publicOnlyReason().?,
        );
        try std.testing.expectEqual(source, access.credentialSource().?);
        try std.testing.expect(access.authorizationCredential() == null);
        try std.testing.expect(access.accountId() == null);
    }
}

test "subscription catalog access preserves source and account identity" {
    for ([_]Source{ .chatgpt_subscription, .grok_subscription }) |source| {
        const access = catalogAccessForCredentialAndAccount(source, "token", "account_1");
        try std.testing.expectEqual(source, access.credentialSource().?);
        try std.testing.expectEqualStrings("token", access.authorizationCredential().?);
        try std.testing.expectEqualStrings("account_1", access.accountId().?);
        const failed = catalogAccessAfterRefreshFailure(source);
        try std.testing.expect(failed.authorizationCredential() == null);
        try std.testing.expectEqual(source, failed.credentialSource().?);
    }
    const managed = catalogAccessForCredentialAndAccount(.host_managed, "ignored", "ignored");
    try std.testing.expect(managed.authorizationCredential() == null);
    try std.testing.expect(managed.accountId() == null);
}
