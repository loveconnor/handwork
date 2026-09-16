const std = @import("std");
const config_runtime = @import("../config/config_runtime.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const host = @import("../hosts/host.zig");
const runtime_profile = @import("../hosts/runtime_profile.zig");
const host_target = @import("../hosts/target.zig");
const io_mod = @import("../shared/io.zig");
const credentials = @import("../auth/credentials.zig");
const auth_runtime = @import("../auth/auth_runtime.zig");
const chatgpt_oauth = @import("../auth/chatgpt_oauth.zig");
const grok_oauth = @import("../auth/grok_oauth.zig");
const provider_catalog = @import("../auth/provider_catalog.zig");
const auth_transition = @import("../auth/auth_transition.zig");
const model_provider = @import("../config/model_provider.zig");
const model_catalog = @import("../provider/model_catalog.zig");
const provider_runtime = @import("provider_runtime.zig");
const picker_state = @import("../input/picker_state.zig");
const provider_picker_runtime = @import("provider_picker_runtime.zig");
const types = @import("../shared/types.zig");

fn oauthAuthEnabled(comptime App: type) bool {
    return runtime_profile.allows(App, .native_auth) or
        runtime_profile.allows(App, .js_host_auth);
}

const ProviderSwitchDecision = auth_transition.ProviderSwitchDecision;
const ProviderSwitchIntent = auth_transition.ProviderSwitchIntent;
const ProviderSwitchFacts = auth_transition.ProviderSwitchFacts;
const decideProviderSwitch = auth_transition.decideProviderSwitch;
const provider_busy_message = "Provider switching is unavailable until active and queued work finishes.";

fn providerFailureMessage(
    intent: ProviderSwitchIntent,
    ordinary: []const u8,
    after_oauth: []const u8,
) []const u8 {
    return if (intent == .post_oauth) after_oauth else ordinary;
}

fn selectCatalogModel(
    entries: []const model_catalog.ModelCatalogEntry,
    primary: ?[]const u8,
    secondary: ?[]const u8,
) ?[]const u8 {
    for ([_]?[]const u8{ primary, secondary }) |maybe_candidate| {
        const candidate = maybe_candidate orelse continue;
        for (entries) |entry| {
            if (std.mem.eql(u8, candidate, entry.id)) return entry.id;
        }
    }
    return if (entries.len > 0) entries[0].id else null;
}

fn hostManagesAuth(app: anytype) bool {
    if (comptime @hasDecl(@TypeOf(app.auth), "isHostManaged")) {
        return app.auth.isHostManaged();
    }
    return false;
}

pub const PendingPromptCredentialReadiness = enum {
    pending,
    current,
    rejected,
};

pub fn Runtime(comptime App: type) type {
    return struct {
        fn compactionOwnsCredentialFeedback(app: *const App) bool {
            return if (comptime @hasField(App, "submission")) app.submission.compaction_pending else false;
        }

        fn ensurePromptCredential(app: *App) !bool {
            if (try rejectPendingPreparation(app)) return false;
            if (comptime provider_runtime.supported(App) and
                @hasDecl(@TypeOf(app.auth), "selectForProvider"))
            {
                const provider = provider_runtime.provider(app);
                if (!model_provider.authorizesCredential(provider, app.auth.credentialSource())) {
                    const selection = selectProviderCredential(app, provider) catch |err| {
                        if (err == error.OutOfMemory) return err;
                        debug_trace.logf("auth", "prompt credential preference load failed err={s}", .{@errorName(err)});
                        if (compactionOwnsCredentialFeedback(app)) return false;
                        try writeAuthNotice(app, .{
                            .topic = "auth",
                            .tone = .@"error",
                            .body = "Could not load authentication settings. Check user settings, then press enter to retry.",
                        });
                        return false;
                    };
                    switch (selection) {
                        .selected => applyCredentialChange(app, true),
                        .unchanged => {},
                        .failed => |failure| return recoverCredentialFailure(app, failure.source, failure.err),
                        .missing => return missingPromptCredential(app, provider),
                    }
                }
            }
            if (app.auth.credentialSource() != null) return true;
            return missingPromptCredential(app, provider_runtime.provider(app));
        }

        fn selectProviderCredential(app: *App, provider: model_provider.ProviderId) !auth_runtime.ProviderCredentialSelection {
            if (hostManagesAuth(app) or model_provider.authorizesCredential(provider, app.auth.credentialSource())) return .unchanged;
            return app.auth.selectForProvider(app.alloc, provider, null);
        }

        pub fn restoreSessionCredential(app: *App, previous_provider: model_provider.ProviderId) !void {
            // Hydration can run before App.init returns, so it must not start background tasks.
            const provider = provider_runtime.provider(app);
            const provider_changed = previous_provider != provider;
            if (provider_changed) {
                app.auth.cancelPromptCredentialRefresh();
                app.model_cache.resetForProviderChange();
            }
            if (comptime host_target.is_wasm) return;
            if (hostManagesAuth(app)) return;
            const selection = selectProviderCredential(app, provider) catch |err| {
                if (err == error.OutOfMemory) return err;
                debug_trace.logf("auth", "resumed credential preference load failed err={s}", .{@errorName(err)});
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .@"error",
                    .body = "Could not load authentication settings for the resumed session. Check user settings and retry.",
                }, true);
                app.shell.render_requests.request(.footer);
                return;
            };
            switch (selection) {
                .selected => app.model_cache.reset(),
                .unchanged => {},
                .missing => try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = switch (provider) {
                        .codex => credentials.missing_chatgpt_interactive_credential_message,
                        .grok => credentials.missing_grok_interactive_credential_message,
                        else => "Set the provider API key environment variable, then select the provider again.",
                    },
                }, true),
                .failed => |failure| {
                    const classified = auth_runtime.classifyCredentialFailure(failure.source, failure.err);
                    const message = if (auth_runtime.preparationError(classified)) |err|
                        auth_runtime.preparationFailureNotice(err).?
                    else
                        "Authentication is unavailable. Run /provider to repair this source.";
                    debug_trace.logf("auth", "resumed credential unavailable source={t} err={s}", .{ failure.source, @errorName(failure.err) });
                    const body = try std.fmt.allocPrint(app.alloc, "{s}: {s}", .{ credentials.sourceLabel(failure.source), message });
                    defer app.alloc.free(body);
                    try app.writeDomainNotice(.{ .topic = "auth", .tone = .@"error", .body = body }, true);
                },
            }
            app.shell.render_requests.request(.footer);
        }

        fn missingPromptCredential(app: *App, provider: model_provider.ProviderId) !bool {
            if (compactionOwnsCredentialFeedback(app)) return false;
            try app.writeDomainNotice(.{
                .topic = "auth",
                .tone = .warning,
                .body = if (provider == .grok) credentials.missing_grok_interactive_credential_message else credentials.missing_chatgpt_interactive_credential_message,
            }, true);
            app.shell.render_requests.request(.footer);
            return false;
        }

        pub fn runLoginCommand(app: *App) !void {
            try runProviderCommand(app);
        }

        pub fn runLogoutCommand(app: *App, target: []const u8) !void {
            if (try rejectPendingPreparation(app)) return;
            if (hostManagesAuth(app)) {
                try writeAuthNotice(app, .{ .topic = "auth", .tone = .neutral, .body = credentials.host_managed_auth_message });
                return;
            }
            if (comptime !oauthAuthEnabled(App)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Authentication is owned by the embedding SDK for this WASM session.",
                }, true);
                return;
            }
            const requested_provider = if (std.mem.trim(u8, target, " \t\r\n").len == 0)
                null
            else
                provider_catalog.parse(std.mem.trim(u8, target, " \t\r\n")) orelse {
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .warning,
                        .body = "Usage: /logout [provider]",
                    });
                    return;
                };
            try app.flushBeforeBlockingExternalWork();
            const selected_provider: model_provider.ProviderId = if (comptime provider_runtime.supported(App))
                provider_runtime.provider(app)
            else
                .codex;
            const provider_inventory = if (comptime @hasDecl(@TypeOf(app.auth), "pickerView")) inventory: {
                try app.auth.refreshSourceInventory(app.alloc);
                break :inventory app.auth.pickerView().available_sources;
            } else @as(auth_runtime.SourceSet, .empty);
            const logout_provider = auth_transition.decideLogoutProvider(.{
                .requested = requested_provider,
                .selected = selected_provider,
                .active_source = app.auth.credentialSource(),
                .available_sources = provider_inventory,
            });
            if (@import("../config/api_providers.zig").find(logout_provider)) |entry| {
                if (entry.anonymous) {
                    const body: []const u8 = if (logout_provider == .opencode)
                        "OpenCode Local has no saved login. Stop the OpenCode server or choose another provider to disconnect."
                    else
                        "Ollama Local has no saved login. Stop your Ollama server or choose another provider to disconnect.";
                    try writeAuthNotice(app, .{ .topic = "auth", .tone = .neutral, .body = body });
                    return;
                }
                if (app.stream.active or !app.worker.tryHoldTurnStart()) {
                    try writeAuthNotice(app, .{ .topic = "auth", .tone = .warning, .body = "Wait for active work to finish before signing out." });
                    return;
                }
                defer app.worker.releaseTurnStartHold();
                try @import("../auth/api_key_store.zig").remove(app.alloc, logout_provider);
                if (comptime @hasDecl(@TypeOf(app.auth), "reconcileAfterApiKeyLogout")) {
                    applyCredentialChange(app, try app.auth.reconcileAfterApiKeyLogout(app.alloc, entry.source));
                }
                const message = try std.fmt.allocPrint(app.alloc, "Saved API key removed. If you also configured {s}, unset it to disconnect completely.", .{entry.key_env});
                defer app.alloc.free(message);
                try writeAuthNotice(app, .{ .topic = "auth", .tone = .neutral, .body = message });
                return;
            }
            const hold_turn_start = logout_provider == selected_provider;
            if (hold_turn_start and (app.stream.active or !app.worker.tryHoldTurnStart())) {
                try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Sign out is unavailable until active and queued work finishes.",
                });
                return;
            }
            defer if (hold_turn_start) app.worker.releaseTurnStartHold();
            if (logout_provider == .grok) {
                const outcome = grok_oauth.logout(app.alloc, app.auth.oauthTransport()) catch {
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .@"error",
                        .body = "Could not durably sign out of Grok. The current source is unchanged.",
                    });
                    return;
                };
                const changed = if (comptime @hasDecl(@TypeOf(app.auth), "reconcileAfterGrokLogout"))
                    try app.auth.reconcileAfterGrokLogout(app.alloc)
                else
                    false;
                applyCredentialChange(app, changed);
                try writeAuthNotice(app, switch (outcome.deletion) {
                    .deleted => .{ .topic = "auth", .tone = .neutral, .body = "Signed out of Grok." },
                    .missing => .{ .topic = "auth", .tone = .neutral, .body = "No Grok login session found." },
                    .deleted_not_durable => .{ .topic = "auth", .tone = .warning, .body = "Signed out of Grok, but could not confirm the profile directory update." },
                });
                if (outcome.revocation_failed) {
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .warning,
                        .body = "The local Grok session was removed, but remote revocation could not be confirmed.",
                    });
                }
                try reconcileSubscriptionLogout(app, .grok);
                return;
            }
            if (logout_provider == .codex) {
                const outcome = chatgpt_oauth.logout() catch {
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .@"error",
                        .body = "Could not durably sign out of Codex. The current source is unchanged.",
                    });
                    return;
                };
                const changed = if (comptime @hasDecl(@TypeOf(app.auth), "reconcileAfterChatGptLogout"))
                    try app.auth.reconcileAfterChatGptLogout(app.alloc)
                else
                    false;
                applyCredentialChange(app, changed);
                try writeAuthNotice(app, switch (outcome) {
                    .deleted => .{ .topic = "auth", .tone = .neutral, .body = "Signed out of Codex." },
                    .missing => .{ .topic = "auth", .tone = .neutral, .body = "No Codex login session found." },
                    .deleted_not_durable => .{ .topic = "auth", .tone = .warning, .body = "Signed out of Codex, but could not confirm the profile directory update." },
                });
                try reconcileSubscriptionLogout(app, .codex);
                return;
            }
        }

        fn reconcileSubscriptionLogout(app: *App, removed: model_provider.ProviderId) !void {
            const selected = provider_runtime.provider(app);
            if (selected != removed) return;
            const candidates = auth_transition.logoutFallbackProviders(.{
                .requested = removed,
                .selected = selected,
                .active_source = app.auth.credentialSource(),
                .available_sources = app.auth.pickerView().available_sources,
            });
            if (candidates[0]) |target| {
                try startProviderSwitch(app, target, false, .manual, candidates[1]);
                return;
            }
            try app.writeDomainNotice(.{
                .topic = "provider",
                .tone = .warning,
                .body = "No connected provider is available. Use /provider to sign in.",
            }, true);
        }

        pub fn runProviderCommand(app: *App) !void {
            if (comptime !runtime_profile.allows(App, .native_auth)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Provider sign-in is managed by the embedding SDK in this WASM session.",
                }, true);
                return;
            }
            try beginProviderPickerInventoryRefresh(app, .provider_picker_command);
        }

        /// Reports blocked provider interaction without changing the composer.
        pub fn reject_provider_picker_if_busy(app: *App) !bool {
            if (!auth_transition.provider_work_busy(app.stream.active, app.worker.queuedPromptCount())) return false;
            try app.writeDomainNotice(.{
                .topic = "provider",
                .tone = .neutral,
                .body = provider_busy_message,
            }, true);
            app.shell.render_requests.request(.footer);
            return true;
        }

        fn beginProviderPickerInventoryRefresh(
            app: *App,
            destination: auth_runtime.InventoryRefreshDestination,
        ) !void {
            if (try reject_provider_picker_if_busy(app)) return;
            const prefix = switch (destination) {
                .provider_picker_login => picker_state.login_prefix,
                .provider_picker_command => picker_state.provider_prefix,
                .auth_picker => unreachable,
            };
            var prepared = try app.input_runtime.textReplacementState().prepare(app.alloc, prefix);
            defer prepared.deinit(app.alloc);
            switch (app.auth.beginSourceInventoryRefresh(app.alloc, .{
                .provider = provider_runtime.provider(app),
                .destination = destination,
            })) {
                .started => {
                    app.input_runtime.textReplacementState().commit(app.alloc, &prepared);
                    app.shell.render_requests.request(.footer);
                },
                .busy => try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Authentication inventory refresh is already in progress.",
                }),
                .failed => try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .@"error",
                    .body = "Authentication sources could not be checked. The picker remains closed.",
                }),
            }
        }

        pub fn collectSourceInventoryFacts(app: *App) !void {
            const result = app.auth.takeSourceInventoryRefresh() orelse return;
            switch (result) {
                .ready => |action| {
                    if (action.destination != .auth_picker and try reject_provider_picker_if_busy(app)) {
                        debug_trace.logf("auth", "provider picker publication dropped destination={t} reason=work_in_progress", .{action.destination});
                        if (comptime @hasField(App, "input_runtime")) {
                            if (app.input_runtime.picker.activeProviderPickerQuery(&app.input_runtime.edit_state) != null) {
                                app.input_runtime.picker.dismissInlinePicker(.provider);
                            }
                        }
                        return;
                    }
                    var unavailable = app.auth.pickerView().unavailable_sources.iterator();
                    while (unavailable.next()) |source| {
                        const body = try std.fmt.allocPrint(
                            app.alloc,
                            "{s} is unavailable. Check the saved credential or choose another option.",
                            .{credentials.sourceLabel(source)},
                        );
                        defer app.alloc.free(body);
                        try writeAuthNotice(app, .{ .topic = "auth", .tone = .warning, .body = body });
                    }
                    switch (action.destination) {
                        .auth_picker => app.auth.openPichandworkorProvider(app.alloc, action.provider),
                        .provider_picker_login, .provider_picker_command => {},
                    }
                    app.shell.render_requests.request(.footer);
                },
                .failed => |action| {
                    if (comptime @hasField(App, "input_runtime")) {
                        if (action.destination != .auth_picker and
                            app.input_runtime.picker.activeProviderPickerQuery(&app.input_runtime.edit_state) != null)
                        {
                            app.input_runtime.picker.dismissInlinePicker(.provider);
                        }
                    }
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .@"error",
                        .body = "Authentication sources could not be checked. The picker was not opened with stale data.",
                    });
                },
            }
        }

        pub fn applyPickerChoice(app: *App, choice: auth_runtime.Choice) !void {
            if (try rejectPendingPreparation(app)) return;
            if (comptime !oauthAuthEnabled(App)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Browser authentication is supplied by the embedding SDK.",
                }, true);
                return;
            }
            switch (choice) {
                .provider => |provider| try switchProvider(app, provider, true, .manual),
                .source => |source| {
                    if (source == .host_managed) return error.UnsupportedCredentialSource;
                    _ = try applySourceChoice(app, source);
                },
                .action => |action| switch (action) {
                    .chatgpt_login => try beginChatGptSignIn(app),
                    .grok_login => try beginGrokSignIn(app),
                    .connections, .switch_provider => try runProviderCommand(app),
                    else => return error.UnsupportedAuthAction,
                },
            }
        }

        pub fn routeAuthPickerByte(app: *App, byte: u8) !bool {
            if (app.auth.signInEntryActive()) {
                if (byte == '\t') {
                    _ = app.auth.toggleSignInCodeEntry();
                } else if (app.auth.signInCodeEntryActive()) {
                    switch (byte) {
                        3, 4 => cancelAndPopPickerStage(app),
                        '\r', '\n' => {
                            if (comptime @hasDecl(@TypeOf(app.auth), "submitApiKey")) {
                                if (app.auth.api_key_provider != null) {
                                    const target = app.auth.submitApiKey(app.alloc) catch |err| {
                                        try app.writeDomainNotice(.{ .topic = "auth", .tone = .@"error", .body = if (err == error.InvalidApiKey) "Use a developer API key. MiniMax Token Plan requires its sk-cp- Subscription Key; Claude subscription OAuth tokens are not supported." else "Could not save the API key. Check permissions on your Handwork profile and try again." }, true);
                                        return true;
                                    };
                                    if (target) |provider| try switchProvider(app, provider, false, .manual);
                                    app.shell.render_requests.request(.footer);
                                    return true;
                                }
                            }
                            _ = try app.auth.submitSignInCode(app.alloc);
                        },
                        8, 127 => _ = app.auth.deleteSignInCodeByte(),
                        else => _ = try app.auth.appendSignInCodeByte(app.alloc, byte),
                    }
                } else {
                    switch (byte) {
                        3, 4 => cancelAndPopPickerStage(app),
                        '\r', '\n' => try openSignInBrowser(app),
                        else => {},
                    }
                }
                app.shell.render_requests.request(.footer);
                return true;
            }
            return false;
        }

        pub fn routeAuthPickerEscapeAction(app: *App, action: anytype) bool {
            if (!app.auth.signInEntryActive()) return false;
            return switch (action) {
                .escape, .remapped_byte => false,
                .paste_start => blk: {
                    if (app.auth.signInCodeEntryActive()) break :blk false;
                    if (!app.auth.toggleSignInCodeEntry()) break :blk true;
                    app.shell.render_requests.request(.footer);
                    break :blk false;
                },
                .paste_end => !app.auth.signInCodeEntryActive(),
                else => true,
            };
        }

        fn cancelAndPopPickerStage(app: *App) void {
            cancelPromptRetryAfterAuth(app);
            _ = app.auth.popPickerStage(app.alloc);
        }

        pub fn collectSignInFacts(app: *App) !void {
            if (comptime !oauthAuthEnabled(App)) return;
            const sign_in_source: credentials.Source = if (comptime @hasDecl(@TypeOf(app.auth), "pickerView"))
                app.auth.pickerView().sign_in_source
            else
                .chatgpt_subscription;
            app.auth.pulseSignIn(app.alloc);
            switch (app.auth.pollSignInTransition(app.alloc)) {
                .none => {},
                .cancelled => {
                    cancelPromptRetryAfterAuth(app);
                    app.shell.render_requests.request(.footer);
                },
                .failed => |err| {
                    cancelPromptRetryAfterAuth(app);
                    debug_trace.logf("auth", "login failed source={t} err={s}", .{ sign_in_source, @errorName(err) });
                    _ = app.auth.popPickerStage(app.alloc);
                    try writeLoginError(app, sign_in_source, err);
                },
                .succeeded => |completed| {
                    var owned = completed;
                    defer owned.deinit(app.alloc);
                    switch (owned) {
                        .none => return error.InvalidSignInCompletion,
                        .chatgpt => {
                            try finishSubscriptionSignIn(app, .codex);
                            return;
                        },
                        .grok => {
                            try finishSubscriptionSignIn(app, .grok);
                            return;
                        },
                    }
                },
            }
        }

        fn finishSubscriptionSignIn(
            app: *App,
            provider: model_provider.ProviderId,
        ) !void {
            try app.auth.refreshSourceInventory(app.alloc);
            switch (auth_transition.signInCompletion(
                provider,
                comptime provider_runtime.supported(App),
            )) {
                .switch_provider => |target| {
                    app.auth.closePicker(app.alloc);
                    try switchProvider(app, target, false, .post_oauth);
                },
                .activate_source => |source| {
                    if (!try selectCredentialSource(app, source)) {
                        cancelPromptRetryAfterAuth(app);
                        _ = app.auth.popPickerStage(app.alloc);
                        try writeAuthNotice(app, .{
                            .topic = "auth",
                            .tone = .@"error",
                            .body = if (provider == .codex)
                                "Signed in, but the Codex subscription credential could not be loaded."
                            else
                                "Signed in, but the Grok subscription credential could not be loaded.",
                        });
                        return;
                    }
                    app.auth.closePicker(app.alloc);
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .neutral,
                        .body = if (provider == .codex)
                            "Signed in with Codex."
                        else
                            "Signed in with Grok.",
                    });
                    try resumePromptAfterAuth(app);
                },
            }
        }

        /// Clearing the remembered choice must also re-resolve, otherwise the
        /// session would keep running on a source precedence no longer selects.
        fn applyAutomaticCredential(app: *App) !void {
            forgetCredentialSource(app);
            app.auth.closePicker(app.alloc);
            applyCredentialChange(app, try app.auth.reselectByPrecedence(app.alloc));
            try app.writeDomainNotice(.{
                .topic = "auth",
                .tone = .neutral,
                .body = "Using automatic credential precedence again.",
            }, true);
            try resumePromptAfterAuth(app);
        }

        fn forgetCredentialSource(app: *App) void {
            var attempt = config_runtime.attemptUserPreferences(
                app.alloc,
                .{ .clear_credential_source = true },
            );
            defer attempt.deinit(app.alloc);
            switch (attempt) {
                .outcome => debug_trace.logf("auth", "credential choice cleared", .{}),
                .failure => |failure| debug_trace.logf(
                    "auth",
                    "credential choice not cleared err={s}",
                    .{@errorName(failure.err)},
                ),
            }
        }

        /// Reports whether the credential actually switched, so callers that
        /// chain further work (the inline picker's provider switch) can stop
        /// when it did not. Failure is already explained to the user here.
        pub fn applySourceChoice(app: *App, source: credentials.Source) !bool {
            if (try rejectPendingPreparation(app)) return false;
            const body = try std.fmt.allocPrint(
                app.alloc,
                "Switched credential to {s}.",
                .{credentials.sourceLabel(source)},
            );
            defer app.alloc.free(body);

            if (!try selectCredentialSource(app, source)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "That credential is no longer available. The current source is unchanged.",
                }, true);
                return false;
            }

            rememberCredentialSource(app, source);
            try app.writeDomainNotice(.{
                .topic = "auth",
                .tone = .neutral,
                .body = body,
            }, true);
            try resumePromptAfterAuth(app);
            return true;
        }

        /// An explicit source choice outlives the session. Failing to persist
        /// leaves the source active for this run rather than refusing a working
        /// credential the user already selected.
        fn rememberCredentialSource(app: *App, source: credentials.Source) void {
            // ChatGPT is selected by model route, not as a global provider
            // credential preference. Its saved session coexists independently.
            if (source == .chatgpt_subscription or source == .grok_subscription) return;
            if (comptime @hasDecl(App, "persistCredentialSourcePreference")) {
                app.persistCredentialSourcePreference(source);
                return;
            }

            var attempt = config_runtime.attemptUserPreferences(
                app.alloc,
                .{ .credential_source = source },
            );
            defer attempt.deinit(app.alloc);
            switch (attempt) {
                .outcome => debug_trace.logf("auth", "credential choice persisted source={t}", .{source}),
                .failure => |failure| debug_trace.logf(
                    "auth",
                    "credential choice not persisted source={t} err={s}",
                    .{ source, @errorName(failure.err) },
                ),
            }
        }

        fn beginChatGptSignIn(app: *App) !void {
            if (comptime provider_runtime.supported(App)) {
                const decision = decideProviderSwitch(.{
                    .current = provider_runtime.provider(app),
                    .target = .codex,
                    .target_credential_ready = false,
                    .intent = .post_oauth,
                    .stream_active = app.stream.active,
                    .queued_prompts = app.worker.queuedPromptCount(),
                });
                if (decision == .busy) {
                    try app.writeDomainNotice(.{
                        .topic = "auth",
                        .tone = .warning,
                        .body = "Codex sign-in is unavailable until active and queued work finishes.",
                    }, true);
                    return;
                }
            }
            try app.flushBeforeBlockingExternalWork();
            const started = app.auth.openChatGptSignInPichandworkromRoot(app.alloc);
            if (started catch |err| {
                cancelPromptRetryAfterAuth(app);
                debug_trace.logf("auth", "ChatGPT login failed err={s}", .{@errorName(err)});
                try writeLoginError(app, .chatgpt_subscription, err);
                return;
            }) {
                app.shell.render_requests.request(.footer);
                if (io_mod.getenv("HANDWORK_NO_OPEN_BROWSER") == null) try openSignInBrowser(app);
            }
        }

        fn beginGrokSignIn(app: *App) !void {
            if (comptime provider_runtime.supported(App)) {
                const decision = decideProviderSwitch(.{
                    .current = provider_runtime.provider(app),
                    .target = .grok,
                    .target_credential_ready = false,
                    .intent = .post_oauth,
                    .stream_active = app.stream.active,
                    .queued_prompts = app.worker.queuedPromptCount(),
                });
                if (decision == .busy) {
                    try app.writeDomainNotice(.{
                        .topic = "auth",
                        .tone = .warning,
                        .body = "Grok sign-in is unavailable until active and queued work finishes.",
                    }, true);
                    return;
                }
            }
            try app.flushBeforeBlockingExternalWork();
            const started = app.auth.openGrokSignInPichandworkromRoot(app.alloc);
            if (started catch |err| {
                cancelPromptRetryAfterAuth(app);
                debug_trace.logf("auth", "Grok login failed err={s}", .{@errorName(err)});
                try writeLoginError(app, .grok_subscription, err);
                return;
            }) {
                app.shell.render_requests.request(.footer);
                if (io_mod.getenv("HANDWORK_NO_OPEN_BROWSER") == null) try openSignInBrowser(app);
            }
        }

        fn beginCodexSignInForProviderSwitch(app: *App) !void {
            try app.flushBeforeBlockingExternalWork();
            const started = app.auth.openChatGptSignInPichandworkorProviderSwitch(app.alloc);
            if (started catch |err| {
                debug_trace.logf("auth", "Codex login failed err={s}", .{@errorName(err)});
                try writeLoginError(app, .chatgpt_subscription, err);
                return;
            }) {
                app.shell.render_requests.request(.footer);
                if (io_mod.getenv("HANDWORK_NO_OPEN_BROWSER") == null) try openSignInBrowser(app);
            }
        }

        fn beginGrokSignInForProviderSwitch(app: *App) !void {
            try app.flushBeforeBlockingExternalWork();
            const started = app.auth.openGrokSignInPichandworkorProviderSwitch(app.alloc);
            if (started catch |err| {
                debug_trace.logf("auth", "Grok login failed err={s}", .{@errorName(err)});
                try writeLoginError(app, .grok_subscription, err);
                return;
            }) {
                app.shell.render_requests.request(.footer);
                if (io_mod.getenv("HANDWORK_NO_OPEN_BROWSER") == null) try openSignInBrowser(app);
            }
        }

        fn switchProvider(
            app: *App,
            target: model_provider.ProviderId,
            allow_login: bool,
            intent: ProviderSwitchIntent,
        ) !void {
            try startProviderSwitch(app, target, allow_login, intent, null);
        }

        fn startProviderSwitch(
            app: *App,
            target: model_provider.ProviderId,
            allow_login: bool,
            intent: ProviderSwitchIntent,
            fallback: ?model_provider.ProviderId,
        ) !void {
            if (!@import("../config/provider_policy.zig").nativeEnabled(target)) {
                try app.writeDomainNotice(.{ .topic = "provider", .tone = .warning, .body = @import("../config/provider_policy.zig").reason(target) }, true);
                return;
            }

            if (comptime !provider_runtime.supported(App) or
                !@hasDecl(App, "providerCatalog") or
                !@hasDecl(@TypeOf(app.auth), "beginProviderPreparation") or host_target.is_wasm)
            {
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .warning,
                    .body = "Provider switching is unavailable in this host.",
                }, true);
                return;
            }
            if (try rejectPendingPreparation(app)) return;
            switch (decideProviderSwitch(.{
                .current = provider_runtime.provider(app),
                .target = target,
                .target_credential_ready = model_provider.authorizesCredential(target, app.auth.credentialSource()),
                .intent = intent,
                .stream_active = app.stream.active or pendingPromptBlocksPreparation(app),
                .queued_prompts = app.worker.queuedPromptCount(),
            })) {
                .prepare => {},
                .no_change => {
                    const body = try std.fmt.allocPrint(app.alloc, "Already using {s}.", .{provider_catalog.label(target)});
                    defer app.alloc.free(body);
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .neutral,
                        .body = body,
                    }, true);
                    return;
                },
                .busy => {
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .warning,
                        .body = providerFailureMessage(intent, provider_busy_message, "Subscription sign-in completed, but provider activation is unavailable until active and queued work finishes. The current provider is unchanged."),
                    }, true);
                    return;
                },
            }
            var settings = config_runtime.loadMergedSettings(app.alloc, app.workspace_root) catch |err| {
                debug_trace.logf("provider", "settings load failed err={s}", .{@errorName(err)});
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .@"error",
                    .body = "Could not load the saved provider selection. The current provider is unchanged.",
                }, true);
                return;
            };
            defer settings.deinit(app.alloc);
            const catalog_provider = app.providerCatalog(target) orelse {
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .@"error",
                    .body = "The target provider catalog is unavailable. The current provider is unchanged.",
                }, true);
                return;
            };
            try beginPreparation(app, .{
                .intent = .{ .provider = .{ .target = target, .allow_login = allow_login, .origin = intent, .fallback = fallback } },
                .catalog_provider = catalog_provider,
                .models_path = app.model_cache.models_path,
                .preferred_source = null,
                .primary_model = if (intent == .post_oauth and provider_runtime.provider(app) == target) provider_runtime.model(app) else null,
                .preferred_model = if (intent == .post_oauth) settings.models.get(target) else io_mod.getenv("HANDWORK_MODEL") orelse settings.models.get(target),
            });
        }

        fn pendingPromptBlocksPreparation(app: *const App) bool {
            if (comptime !@hasField(App, "submission")) return false;
            const pending = app.submission.pending orelse return false;
            return pending.credential_admitted or pending.phase == .queued;
        }

        fn pendingPromptNeedsAdoption(app: *const App) bool {
            if (comptime !@hasField(App, "submission")) return false;
            const pending = app.submission.pending orelse return false;
            return pending.phase == .awaiting_frame or pending.phase == .awaiting_adoption;
        }

        fn rejectPendingPreparation(app: *App) !bool {
            if (comptime !@hasDecl(@TypeOf(app.auth), "providerPreparationPending")) return false;
            if (!app.auth.providerPreparationPending()) return false;
            try app.writeDomainNotice(.{
                .topic = "provider",
                .tone = .neutral,
                .body = "Provider preparation is still in progress. ctrl+c cancels.",
            }, true);
            return true;
        }

        fn beginPreparation(app: *App, input: auth_runtime.ProviderPreparationInput) !void {
            app.auth.beginProviderPreparation(app.alloc, input) catch |err| {
                debug_trace.logf("provider", "preparation start failed err={s}", .{@errorName(err)});
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .@"error",
                    .body = "Could not start provider preparation. The current provider is unchanged.",
                }, true);
                return;
            };
            const body = try std.fmt.allocPrint(app.alloc, "Preparing {s}.", .{provider_catalog.label(input.target())});
            defer app.alloc.free(body);
            try app.writeDomainNotice(.{
                .topic = "provider",
                .tone = .neutral,
                .body = body,
            }, true);
        }

        pub fn collectProviderPreparationFacts(app: *App) !void {
            if (comptime !@hasDecl(@TypeOf(app.auth), "takeProviderPreparation") or host_target.is_wasm) return;
            if (pendingPromptNeedsAdoption(app)) return;
            const task = app.auth.takeProviderPreparation() orelse return;
            defer task.deinit();
            if (task.cancel_requested.load(.seq_cst)) {
                holdPromptAfterPreparationFailure(app);
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .neutral,
                    .body = "Provider preparation cancelled. The current provider is unchanged.",
                }, true);
                return;
            }
            const applied = switch (task.input.intent) {
                .provider => try finishProviderSwitch(app, task),
            };
            if (applied) {
                if (comptime @hasField(App, "submission")) {
                    if (app.submission.pending) |pending| {
                        if (pending.phase == .awaiting_auth) requestPromptRetryAfterAuth(app);
                    }
                }
                try resumePromptAfterAuth(app);
                return;
            }
            if (task.input.intent == .provider) {
                if (task.input.intent.provider.fallback) |target| {
                    try startProviderSwitch(app, target, false, .manual, null);
                    if (app.auth.providerPreparationPending()) return;
                }
            }
            holdPromptAfterPreparationFailure(app);
        }

        fn holdPromptAfterPreparationFailure(app: *App) void {
            if (comptime !@hasField(App, "submission")) return;
            if (app.submission.pending) |*pending| {
                if (pending.phase == .adopted) {
                    pending.phase = .awaiting_auth;
                    app.submission.retry_after_auth = app.auth.signInEntryActive();
                    debug_trace.logf("provider", "pending prompt retained after preparation failure", .{});
                }
            }
        }

        fn finishProviderSwitch(app: *App, task: *auth_runtime.ProviderPreparation) !bool {
            const request = task.input.intent.provider;
            const target = request.target;
            const intent = request.origin;
            if (task.failure) |err| {
                debug_trace.logf("provider", "preparation failed target={t} err={s}", .{ target, @errorName(err) });
                if (task.credential == null and !hostManagesAuth(app)) {
                    const body = try auth_runtime.preparationFailureText(app.alloc, target, err);
                    defer app.alloc.free(body);
                    try app.writeDomainNotice(.{
                        .topic = "auth",
                        .tone = .@"error",
                        .body = body,
                    }, true);
                } else {
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .@"error",
                        .body = providerFailureMessage(intent, "Could not load the target provider catalog. The current provider is unchanged.", "Subscription sign-in completed, but its model catalog could not be loaded. The current provider is unchanged."),
                    }, true);
                }
                return false;
            }
            if (task.credential == null and !hostManagesAuth(app)) {
                if (request.allow_login) {
                    switch (target) {
                        .codex => try beginCodexSignInForProviderSwitch(app),
                        .grok => try beginGrokSignInForProviderSwitch(app),
                        else => try openApiKeyPrompt(app, target),
                    }
                }
                if (!request.allow_login) {
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .warning,
                        .body = if (intent == .post_oauth) "Subscription sign-in completed, but its saved credential is unavailable. The current provider is unchanged." else if (target == .codex) "Run handwork login codex, then try switching again." else if (target == .grok) "Run handwork login grok, then try switching again." else credentials.missing_interactive_credential_message,
                    }, true);
                }
                return false;
            }
            const fetched = task.catalog orelse return false;
            task.catalog = null;
            var catalog = switch (fetched) {
                .catalog => |catalog| catalog,
                .failure => |failure| {
                    debug_trace.logf("provider", "catalog rejected provider={t} category={t}", .{ target, failure.category });
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .@"error",
                        .body = if (failure.category == .cancellation)
                            "Provider switching was cancelled. The current provider is unchanged."
                        else if (target == .opencode and failure.category == .transport)
                            "Handwork could not reach OpenCode Local. Install opencode and make sure it is available on PATH. If HANDWORK_OPENCODE_BASE_URL is set, check that server address."
                        else
                            providerFailureMessage(intent, "The target provider catalog could not be validated. The current provider is unchanged.", "Subscription sign-in completed, but its model catalog could not be validated. The current provider is unchanged."),
                    }, true);
                    return false;
                },
            };
            defer model_catalog.freeModelCatalog(app.alloc, &catalog);
            const selected_model = selectCatalogModel(catalog.items, task.input.primary_model, task.input.preferred_model) orelse {
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .@"error",
                    .body = providerFailureMessage(intent, "The target provider returned no supported models. The current provider is unchanged.", "Subscription sign-in completed, but its model catalog returned no supported models. The current provider is unchanged."),
                }, true);
                return false;
            };
            var credential = task.credential;
            task.credential = null;
            defer if (credential) |*value| value.deinit(app.alloc);
            const access: credentials.CatalogAccess = if (hostManagesAuth(app)) .host_managed else credentials.catalogAccessForCredentialAndAccount(credential.?.source, credential.?.token, credential.?.accountId());
            var owned_model = try app.alloc.dupe(u8, selected_model);
            defer app.alloc.free(owned_model);

            if (auth_transition.provider_work_busy(app.stream.active, app.worker.queuedPromptCount())) {
                try app.writeDomainNotice(.{
                    .topic = "provider",
                    .tone = .warning,
                    .body = providerFailureMessage(
                        intent,
                        provider_busy_message,
                        "Subscription sign-in completed, but provider activation is unavailable until active and queued work finishes. The current provider is unchanged.",
                    ),
                }, true);
                return false;
            }

            app.model_cache.adoptOwnedCatalog(access, &catalog);
            app.provider_selection.adoptOwned(target, &owned_model);
            if (credential) |*value| _ = app.auth.adoptCredential(app.alloc, value);
            reconcileCredential(app);

            const body = try std.fmt.allocPrint(
                app.alloc,
                "Switched to {s} with {s}.",
                .{ provider_catalog.label(target), provider_runtime.model(app) },
            );
            defer app.alloc.free(body);
            if (comptime @hasDecl(App, "persistRuntimePreferences")) {
                var persistence = app.persistRuntimePreferences(.{
                    .provider = target,
                    .model = provider_runtime.model(app),
                });
                defer persistence.deinit(app.alloc);
                if (persistence.settings_error != null or persistence.session_error != null) {
                    debug_trace.logf(
                        "provider",
                        "runtime switch persistence failed settings={s} session={s}",
                        .{
                            if (persistence.settings_error) |err| @errorName(err) else "none",
                            if (persistence.session_error) |err| @errorName(err) else "none",
                        },
                    );
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .warning,
                        .body = "Provider switched for this run, but the selection could not be saved.",
                    }, true);
                } else {
                    try app.writeDomainNotice(.{
                        .topic = "provider",
                        .tone = .neutral,
                        .body = body,
                    }, true);
                }
            } else {
                var persistence = config_runtime.attemptUserPreferences(app.alloc, .{
                    .provider = target,
                    .model_preference = .{
                        .provider = target,
                        .model = provider_runtime.model(app),
                    },
                });
                defer persistence.deinit(app.alloc);
                switch (persistence) {
                    .outcome => try app.writeDomainNotice(.{ .topic = "provider", .tone = .neutral, .body = body }, true),
                    .failure => |failure| {
                        debug_trace.logf("provider", "runtime switch persistence failed err={s}", .{@errorName(failure.err)});
                        try app.writeDomainNotice(.{
                            .topic = "provider",
                            .tone = .warning,
                            .body = "Provider switched for this run, but the selection could not be saved.",
                        }, true);
                    },
                }
            }
            app.shell.render_requests.request(.footer);
            return true;
        }

        fn beginSignIn(app: *App, _: bool) !void {
            switch (provider_runtime.provider(app)) {
                .codex => try beginChatGptSignIn(app),
                .grok => try beginGrokSignIn(app),
                else => try openApiKeyPrompt(app, provider_runtime.provider(app)),
            }
        }

        fn openApiKeyPrompt(app: *App, target: model_provider.ProviderId) !void {
            const entry = @import("../config/api_providers.zig").find(target) orelse return;
            if (entry.anonymous) {
                const body: []const u8 = if (target == .opencode)
                    "Choose OpenCode Local and Handwork will start opencode serve on demand. No API key is required. HANDWORK_OPENCODE_BASE_URL disables automatic startup and overrides the endpoint; HANDWORK_OPENCODE_MODEL overrides the model."
                else
                    "Start Ollama with ollama serve and pull a model, then choose Ollama Local. No API key is required. HANDWORK_OLLAMA_BASE_URL and HANDWORK_OLLAMA_MODEL override the endpoint and model.";
                try app.writeDomainNotice(.{ .topic = "auth", .tone = .neutral, .body = body }, true);
                return;
            }
            if (comptime @hasDecl(@TypeOf(app.auth), "openApiKeyEntry")) {
                app.auth.openApiKeyEntry(app.alloc, target);
                app.shell.render_requests.request(.footer);
            }
        }

        fn openSignInBrowser(app: *App) !void {
            const url = (try app.auth.signInBrowserUrlAlloc(app.alloc)) orelse return;
            defer app.alloc.free(url);
            if (!try app.urlOpener().open(app.alloc, url)) {
                debug_trace.logf("auth", "login browser launcher failed", .{});
            }
        }

        pub fn selectCredentialSource(app: *App, source: credentials.Source) !bool {
            const changed = (try app.auth.selectSource(app.alloc, source)) orelse return false;
            applyCredentialChange(app, changed);
            return true;
        }

        fn refreshSelectedCredentialIfNeeded(app: *App) !void {
            const change = try app.auth.refreshSelectedCredentialIfNeeded(app.alloc);
            applyCredentialRefreshChange(app, change);
        }

        fn applyCredentialRefreshChange(
            app: *App,
            change: auth_transition.CredentialChange,
        ) void {
            if (change == .none) return;
            reconcileCredential(app);
            if (app.auth.modelCatalogAccess().authorizationCredential() == null) return;
            if (change == .authority) app.model_cache.reset();
            if (comptime @hasDecl(App, "startModelCacheWarmup")) {
                app.startModelCacheWarmup();
            }
        }

        pub fn admitPromptCredential(app: *App) !bool {
            if (comptime !oauthAuthEnabled(App)) {
                if (app.auth.credentialLease() != null) return true;
                if (compactionOwnsCredentialFeedback(app)) return false;
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Authentication is unavailable. Connect Codex or Grok through the embedding SDK.",
                }, true);
                return false;
            }
            if (!try ensurePromptCredential(app)) return false;
            return preparePromptCredential(app);
        }

        pub fn startPromptCredentialPrewarm(app: *App) void {
            if (comptime @hasDecl(@TypeOf(app.auth), "providerPreparationPending")) {
                if (app.auth.providerPreparationPending()) return;
            }
            if (comptime !@hasDecl(@TypeOf(app.auth), "beginPromptCredentialRefresh")) return;
            if (comptime provider_runtime.supported(App)) {
                if (!model_provider.authorizesCredential(provider_runtime.provider(app), app.auth.credentialSource())) return;
            }
            const outcome = app.auth.beginPromptCredentialRefresh();
            debug_trace.logf(
                "auth",
                "prompt credential prewarm start outcome={s}",
                .{@tagName(outcome)},
            );
        }

        pub fn collectPendingPromptCredential(
            app: *App,
        ) !PendingPromptCredentialReadiness {
            if (comptime @hasDecl(@TypeOf(app.auth), "providerPreparationPending")) {
                if (app.auth.providerPreparationPending()) return .pending;
            }
            if (comptime host_target.is_wasm) {
                return if (try admitPromptCredential(app)) .current else .rejected;
            }
            if (!try ensurePromptCredential(app)) return .rejected;
            const source = app.auth.credentialSource() orelse return .rejected;
            if (!credentials.sourceRefreshable(source)) {
                return if (app.auth.credentialLease() != null) .current else .rejected;
            }

            var refresh = app.auth.pollPromptCredentialRefresh();
            defer refresh.deinit();
            switch (refresh) {
                .idle => {
                    return switch (app.auth.beginPromptCredentialRefresh()) {
                        .started, .pending => .pending,
                        .not_needed => if (app.auth.credentialLease() != null) .current else .rejected,
                        .failed => if (try admitPromptCredential(app)) .current else .rejected,
                    };
                },
                .pending => return .pending,
                .failed => |failure| {
                    _ = try recoverCredentialFailure(app, failure.source, failure.err);
                    return .rejected;
                },
                .ready => |*refreshed| {
                    var owned = try refreshed.clone(app.alloc);
                    defer owned.deinit(app.alloc);
                    const change = app.auth.adoptPreparedCredential(app.alloc, &owned);
                    applyCredentialRefreshChange(app, change);
                    return if (app.auth.credentialLease() != null) .current else .pending;
                },
            }
        }

        pub fn retryPendingPromptCredential(
            app: *App,
        ) !PendingPromptCredentialReadiness {
            if (comptime @hasDecl(@TypeOf(app.auth), "providerPreparationPending")) {
                if (app.auth.providerPreparationPending()) return .pending;
            }
            if (comptime host_target.is_wasm) {
                return if (try admitPromptCredential(app)) .current else .rejected;
            }
            if (!try ensurePromptCredential(app)) return .rejected;
            if (comptime @hasDecl(@TypeOf(app.auth), "credentialFailure")) {
                if (app.auth.credentialFailure()) |failure| {
                    if (!failure.retryable()) {
                        return if (try preparePromptCredential(app)) .current else .rejected;
                    }
                }
            }
            app.auth.cancelPromptCredentialRefresh();
            return switch (app.auth.beginPromptCredentialRefresh()) {
                .started, .pending => .pending,
                .not_needed => if (app.auth.credentialLease() != null) .current else .rejected,
                .failed => if (try preparePromptCredential(app)) .current else .rejected,
            };
        }

        fn preparePromptCredential(app: *App) !bool {
            if (comptime @hasDecl(@TypeOf(app.auth), "credentialFailure")) {
                if (app.auth.credentialFailure()) |failure| {
                    if (failure.requiresSignIn()) {
                        try beginCredentialRepair(app, failure);
                        return false;
                    }
                }
            }
            for (0..2) |_| {
                refreshSelectedCredentialIfNeeded(app) catch |err| switch (err) {
                    error.OutOfMemory => return err,
                    else => return recoverPromptCredentialRefreshFailure(app, err),
                };
                if (app.auth.credentialLease() != null) return true;
            }
            return recoverPromptCredentialRefreshFailure(app, error.CredentialRefreshUnavailable);
        }

        fn beginCredentialRepair(
            app: *App,
            failure: auth_runtime.CredentialFailure,
        ) !void {
            requestPromptRetryAfterAuth(app);
            switch (failure.source) {
                .chatgpt_subscription => try beginChatGptSignIn(app),
                .grok_subscription => try beginGrokSignIn(app),
                .host_managed,
                => {},
                else => try openApiKeyPrompt(app, provider_runtime.provider(app)),
            }
        }

        fn requestPromptRetryAfterAuth(app: *App) void {
            if (comptime @hasDecl(App, "requestPromptRetryAfterAuth")) {
                app.requestPromptRetryAfterAuth();
            }
        }

        fn cancelPromptRetryAfterAuth(app: *App) void {
            if (comptime @hasDecl(App, "cancelPromptRetryAfterAuth")) {
                app.cancelPromptRetryAfterAuth();
            }
        }

        fn resumePromptAfterAuth(app: *App) !void {
            if (comptime @hasDecl(App, "resumePromptAfterAuth")) {
                try app.resumePromptAfterAuth();
            }
        }

        fn recoverPromptCredentialRefreshFailure(app: *App, err: anyerror) !bool {
            const active_source = app.auth.credentialSource();
            const source = if (active_source) |active|
                if (credentials.sourceRefreshable(active)) active else .chatgpt_subscription
            else
                .chatgpt_subscription;
            return recoverCredentialFailure(app, source, err);
        }

        fn recoverCredentialFailure(app: *App, source: credentials.Source, err: anyerror) !bool {
            debug_trace.logf("auth", "prompt credential refresh failed source={t} err={s}", .{ source, @errorName(err) });
            const failure = auth_runtime.classifyCredentialFailure(source, err);
            debug_trace.logf(
                "auth",
                "credential failure source={t} reason={t} retryable={s}",
                .{ failure.source, failure.reason, if (failure.retryable()) "true" else "false" },
            );
            const notify = !compactionOwnsCredentialFeedback(app);
            const should_notify = if (app.auth.credentialSource() == source and
                comptime @hasDecl(@TypeOf(app.auth), "recordCredentialFailure"))
                app.auth.recordCredentialFailure(failure, .{ .notify = notify })
            else
                notify;
            if (!should_notify) return false;
            const recovery = try credentialRecoveryText(app.alloc, failure);
            defer app.alloc.free(recovery);
            try app.writeDomainNotice(.{
                .topic = "auth",
                .tone = .@"error",
                .body = recovery,
            }, true);
            app.shell.render_requests.request(.footer);
            return false;
        }

        fn credentialRecoveryText(
            alloc: std.mem.Allocator,
            failure: auth_runtime.CredentialFailure,
        ) ![]u8 {
            const source_label = credentials.sourceLabel(failure.source);
            return switch (failure.reason) {
                .invalid_credential => std.fmt.allocPrint(
                    alloc,
                    "{s} sign-in expired.\npress enter to sign in again. Your prompt is saved.",
                    .{source_label},
                ),
                .invalid_storage => std.fmt.allocPrint(
                    alloc,
                    "{s}: Saved credential storage is unavailable.\nCheck credential storage, then press enter to retry. Your prompt is saved.",
                    .{source_label},
                ),
                .persistence_uncertain => std.fmt.allocPrint(
                    alloc,
                    "{s} refresh could not be saved.\npress enter to sign in again. Your prompt is saved.",
                    .{source_label},
                ),
                .authority_changed => std.fmt.allocPrint(
                    alloc,
                    "{s} account changed during refresh.\nReview authentication before retrying. Your prompt is saved.",
                    .{source_label},
                ),
                .temporary_unavailable => std.fmt.allocPrint(
                    alloc,
                    "{s} credential refresh failed.\npress enter to retry. Your prompt is saved.",
                    .{source_label},
                ),
            };
        }

        fn applyCredentialChange(app: *App, changed: bool) void {
            if (!changed) return;
            if (comptime @hasDecl(@TypeOf(app.auth), "cancelPromptCredentialRefresh")) {
                app.auth.cancelPromptCredentialRefresh();
            }
            reconcileCredential(app);
            app.model_cache.reset();
            if (comptime @hasDecl(App, "startModelCacheWarmup")) {
                app.startModelCacheWarmup();
            }
        }

        fn reconcileCredential(app: *App) void {
            if (comptime !runtime_profile.allows(App, .generation_usage)) return;
            if (comptime @hasField(App, "session") and @hasField(@TypeOf(app.session), "usage")) {
                if (hostManagesAuth(app)) {
                    if (comptime @hasDecl(@TypeOf(app.session.usage), "replaceHostManagedReconciliationAuthority")) {
                        app.session.usage.replaceHostManagedReconciliationAuthority(app.alloc, provider_runtime.provider(app));
                        return;
                    }
                }
                if (comptime @hasDecl(@TypeOf(app.session.usage), "replaceProviderReconciliationCredential")) {
                    if (app.auth.credentialLease()) |lease| {
                        const source = lease.credentialSource();
                        if (model_provider.authorizesCredential(provider_runtime.provider(app), source)) {
                            if (lease.secret()) |token| {
                                app.session.usage.replaceProviderReconciliationCredential(
                                    app.alloc,
                                    provider_runtime.provider(app),
                                    source.?,
                                    lease.accountId(),
                                    token,
                                );
                                return;
                            }
                        }
                    }
                }
                app.session.usage.clearReconciliationCredential();
            }
        }

        fn writeLoginError(app: *App, source: credentials.Source, err: anyerror) !void {
            const failure = auth_runtime.classifyCredentialFailure(source, err);
            if (failure.reason == .invalid_storage or failure.reason == .persistence_uncertain) {
                const notice = auth_runtime.preparationFailureNotice(auth_runtime.preparationError(failure).?).?;
                const body = try std.fmt.allocPrint(app.alloc, "{s}: {s}", .{ credentials.sourceLabel(source), notice });
                defer app.alloc.free(body);
                try writeAuthNotice(app, .{ .topic = "auth", .tone = .@"error", .body = body });
                return;
            }
            const notice: types.SemanticNotice = if (source == .chatgpt_subscription)
                switch (err) {
                    error.ChatGptAuthorizationFailed => .{ .topic = "auth", .tone = .@"error", .body = "Codex sign-in was denied. The current credential is unchanged." },
                    error.ChatGptLoginTimedOut, error.LoginTimedOut => .{ .topic = "auth", .tone = .warning, .body = "Codex sign-in expired. The current credential is unchanged; run /provider to try again." },
                    else => .{ .topic = "auth", .tone = .@"error", .body = "Codex sign-in failed. The current credential is unchanged." },
                }
            else if (source == .grok_subscription)
                switch (err) {
                    error.GrokAuthorizationFailed => .{ .topic = "auth", .tone = .@"error", .body = "Grok sign-in was denied. The current credential is unchanged." },
                    error.GrokLoginTimedOut, error.LoginTimedOut => .{ .topic = "auth", .tone = .warning, .body = "Grok sign-in expired. The current credential is unchanged; run /provider to try again." },
                    else => .{ .topic = "auth", .tone = .@"error", .body = "Grok sign-in failed. The current credential is unchanged." },
                }
            else
                .{ .topic = "auth", .tone = .@"error", .body = "Authentication is managed by the embedding host." };
            try writeAuthNotice(app, notice);
        }

        fn writeAuthNotice(app: *App, notice: types.SemanticNotice) !void {
            try app.writeDomainNotice(notice, true);
            app.shell.render_requests.request(.first_frame);
            try app.flushBeforeBlockingExternalWork();
        }
    };
}

test "provider preparation waits for prompt adoption and protects admitted prompts" {
    const submission = @import("input_submit_runtime.zig");
    const FakeApp = struct { submission: submission.State = .{} };
    var app: FakeApp = .{};
    try std.testing.expect(!Runtime(FakeApp).pendingPromptBlocksPreparation(&app));
    try std.testing.expect(!Runtime(FakeApp).pendingPromptNeedsAdoption(&app));
    app.submission.pending = .{ .draft = .{ .turn_id = 1, .prompt = &.{}, .images = &.{}, .skill_display_spans = &.{} } };
    for ([_]submission.PendingPhase{ .awaiting_frame, .awaiting_adoption }) |phase| {
        app.submission.pending.?.phase = phase;
        try std.testing.expect(!Runtime(FakeApp).pendingPromptBlocksPreparation(&app));
        try std.testing.expect(Runtime(FakeApp).pendingPromptNeedsAdoption(&app));
    }
    app.submission.pending.?.phase = .adopted;
    try std.testing.expect(!Runtime(FakeApp).pendingPromptBlocksPreparation(&app));
    app.submission.pending.?.credential_admitted = true;
    try std.testing.expect(Runtime(FakeApp).pendingPromptBlocksPreparation(&app));
    app.submission.pending.?.credential_admitted = false;
    for ([_]submission.PendingPhase{.queued}) |phase| {
        app.submission.pending.?.phase = phase;
        try std.testing.expect(Runtime(FakeApp).pendingPromptBlocksPreparation(&app));
        try std.testing.expect(!Runtime(FakeApp).pendingPromptNeedsAdoption(&app));
    }
    app.submission.pending.?.phase = .awaiting_auth;
    try std.testing.expect(!Runtime(FakeApp).pendingPromptBlocksPreparation(&app));
    try std.testing.expect(!Runtime(FakeApp).pendingPromptNeedsAdoption(&app));
}

test "provider switch state machine no-ops rejects busy work and prepares only idle changes" {
    try std.testing.expectEqual(
        ProviderSwitchDecision.no_change,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = true,
            .intent = .manual,
            .stream_active = true,
            .queued_prompts = 2,
        }),
    );
    try std.testing.expectEqual(
        ProviderSwitchDecision.prepare,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = false,
            .intent = .manual,
            .stream_active = false,
            .queued_prompts = 0,
        }),
    );
    try std.testing.expectEqual(
        ProviderSwitchDecision.busy,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = false,
            .intent = .manual,
            .stream_active = true,
            .queued_prompts = 0,
        }),
    );
    try std.testing.expectEqual(
        ProviderSwitchDecision.busy,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = false,
            .intent = .manual,
            .stream_active = false,
            .queued_prompts = 1,
        }),
    );
    try std.testing.expectEqual(
        ProviderSwitchDecision.prepare,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = true,
            .intent = .post_oauth,
            .stream_active = false,
            .queued_prompts = 0,
        }),
    );
    try std.testing.expectEqual(
        ProviderSwitchDecision.busy,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = true,
            .intent = .post_oauth,
            .stream_active = false,
            .queued_prompts = 1,
        }),
    );
    try std.testing.expectEqual(
        ProviderSwitchDecision.prepare,
        decideProviderSwitch(.{
            .current = .codex,
            .target = .codex,
            .target_credential_ready = false,
            .intent = .manual,
            .stream_active = false,
            .queued_prompts = 0,
        }),
    );
}

test "post OAuth catalog selection keeps valid current then saved then first" {
    const entries = [_]model_catalog.ModelCatalogEntry{
        .{ .id = @constCast("first"), .model_type = @constCast("language") },
        .{ .id = @constCast("current"), .model_type = @constCast("language") },
        .{ .id = @constCast("saved"), .model_type = @constCast("language") },
    };

    try std.testing.expectEqualStrings("current", selectCatalogModel(&entries, "current", "saved").?);
    try std.testing.expectEqualStrings("saved", selectCatalogModel(&entries, "missing", "saved").?);
    try std.testing.expectEqualStrings("first", selectCatalogModel(&entries, "missing", "also-missing").?);
    try std.testing.expect(selectCatalogModel(&.{}, "current", "saved") == null);
}

const TestModelCache = struct {
    models_path: []const u8 = "/models",
    reset_count: usize = 0,

    fn reset(self: *TestModelCache) void {
        self.reset_count += 1;
    }
};

const BusySignInAuth = struct {
    start_count: usize = 0,

    fn openChatGptSignInPichandworkromRoot(self: *BusySignInAuth, _: std.mem.Allocator) !bool {
        self.start_count += 1;
        return true;
    }

    fn openGrokSignInPichandworkromRoot(self: *BusySignInAuth, _: std.mem.Allocator) !bool {
        self.start_count += 1;
        return true;
    }

    fn signInBrowserUrlAlloc(_: *BusySignInAuth, _: std.mem.Allocator) !?[]u8 {
        return null;
    }
};

const BusySignInApp = struct {
    pub const host_profile = runtime_profile.native;

    alloc: std.mem.Allocator = std.testing.allocator,
    selected_provider: model_provider.ProviderId = .codex,
    selected_model: std.ArrayList(u8) = .empty,
    auth: BusySignInAuth = .{},
    stream: struct { active: bool = false } = .{},
    worker: struct {
        queued_prompts: usize = 0,

        fn queuedPromptCount(self: @This()) usize {
            return self.queued_prompts;
        }
    } = .{},
    shell: struct { render_requests: TestRenderRequests = .{} } = .{},
    notice_count: usize = 0,
    flush_count: usize = 0,

    fn deinit(self: *BusySignInApp) void {
        self.selected_model.deinit(self.alloc);
    }

    fn writeDomainNotice(self: *BusySignInApp, _: types.SemanticNotice, _: bool) !void {
        self.notice_count += 1;
    }

    fn flushBeforeBlockingExternalWork(self: *BusySignInApp) !void {
        self.flush_count += 1;
    }

    fn urlOpener(_: *BusySignInApp) host.UrlOpener {
        return host.unavailable_url_opener;
    }
};

test "interactive subscription sign-in rejects active and queued work before OAuth" {
    const cases = [_]struct {
        stream_active: bool,
        queued_prompts: usize,
    }{
        .{ .stream_active = true, .queued_prompts = 0 },
        .{ .stream_active = false, .queued_prompts = 1 },
    };

    for (cases) |case| {
        inline for ([_]model_provider.ProviderId{ .codex, .grok }) |provider| {
            var app: BusySignInApp = .{};
            defer app.deinit();
            app.stream.active = case.stream_active;
            app.worker.queued_prompts = case.queued_prompts;

            switch (provider) {
                .codex => try Runtime(BusySignInApp).beginChatGptSignIn(&app),
                .grok => try Runtime(BusySignInApp).beginGrokSignIn(&app),
                else => unreachable,
            }

            try std.testing.expectEqual(@as(usize, 0), app.auth.start_count);
            try std.testing.expectEqual(@as(usize, 0), app.flush_count);
            try std.testing.expectEqual(@as(usize, 1), app.notice_count);
        }
    }
}

const TestAuth = struct {
    select_result: ?bool = false,
    sign_in_transition: auth_runtime.SignInTransition = .none,
    logout_changed: bool = false,
    refresh_change: auth_transition.CredentialChange = .none,
    refresh_error: ?anyerror = null,
    selected_source: ?credentials.Source = null,
    active_source: ?credentials.Source = .chatgpt_subscription,
    onboarding_skipped: bool = false,
    refresh_count: usize = 0,
    logout_reconcile_count: usize = 0,
    source_inventory_refresh_count: usize = 0,
    credential_failure: ?auth_runtime.CredentialFailure = null,
    credential_notice_claimed: bool = false,
    picker_opened: bool = false,
    picker_provider: model_provider.ProviderId = .codex,
    picker_closed: bool = false,
    credential_ready: bool = true,
    catalog_ready: bool = true,
    credential_ready_after_refresh_count: ?usize = null,
    sign_in_url: ?[]const u8 = null,
    picker_pop_count: usize = 0,
    sign_in_entry_active: bool = false,
    sign_in_start_count: usize = 0,
    sign_in_code_entry_active: bool = false,
    sign_in_code_toggle_count: usize = 0,
    sign_in_code_toggle_succeeds: bool = true,
    sign_in_code_submit_count: usize = 0,
    sign_in_code_submit_succeeds: bool = true,
    inventory_refresh_action: ?auth_runtime.InventoryRefreshAction = null,
    inventory_refresh_fails: bool = false,
    prompt_refresh_start: auth_runtime.PromptCredentialRefreshStart = .not_needed,
    prompt_refresh_start_count: usize = 0,

    fn credentialSource(self: *const TestAuth) ?credentials.Source {
        return self.active_source;
    }

    fn view(self: *const TestAuth) auth_runtime.View {
        return .{
            .active_source = self.active_source,
            .available_inactive_sources = .empty,
            .refreshable = if (self.active_source) |source|
                credentials.sourceRefreshable(source)
            else
                false,
            .chatgpt_subscription_status = .not_attempted,
            .onboarding_skipped = self.onboarding_skipped,
        };
    }

    fn beginPromptCredentialRefresh(self: *TestAuth) auth_runtime.PromptCredentialRefreshStart {
        self.prompt_refresh_start_count += 1;
        return self.prompt_refresh_start;
    }

    fn pollPromptCredentialRefresh(_: *TestAuth) auth_runtime.PromptCredentialRefreshPoll {
        return .idle;
    }

    fn cancelPromptCredentialRefresh(_: *TestAuth) void {}

    fn selectSource(self: *TestAuth, _: std.mem.Allocator, source: credentials.Source) !?bool {
        self.selected_source = source;
        if (self.select_result != null) self.active_source = source;
        return self.select_result;
    }

    fn pollSignInTransition(self: *TestAuth, _: std.mem.Allocator) auth_runtime.SignInTransition {
        const transition = self.sign_in_transition;
        self.sign_in_transition = .none;
        return transition;
    }

    fn pulseSignIn(_: *TestAuth, _: std.mem.Allocator) void {}

    fn popPickerStage(self: *TestAuth, _: std.mem.Allocator) bool {
        self.picker_pop_count += 1;
        return true;
    }

    fn signInEntryActive(self: *const TestAuth) bool {
        return self.sign_in_entry_active;
    }

    fn openSignInPicker(self: *TestAuth, _: std.mem.Allocator) !bool {
        if (self.sign_in_entry_active) return false;
        self.sign_in_entry_active = true;
        self.sign_in_start_count += 1;
        return true;
    }

    fn openChatGptSignInPichandworkromRoot(self: *TestAuth, alloc: std.mem.Allocator) !bool {
        return self.openSignInPicker(alloc);
    }

    fn openGrokSignInPichandworkromRoot(self: *TestAuth, alloc: std.mem.Allocator) !bool {
        return self.openSignInPicker(alloc);
    }

    fn signInCodeEntryActive(self: *const TestAuth) bool {
        return self.sign_in_code_entry_active;
    }

    fn toggleSignInCodeEntry(self: *TestAuth) bool {
        self.sign_in_code_toggle_count += 1;
        if (!self.sign_in_code_toggle_succeeds) return false;
        self.sign_in_code_entry_active = !self.sign_in_code_entry_active;
        return true;
    }

    fn submitSignInCode(self: *TestAuth, _: std.mem.Allocator) !bool {
        self.sign_in_code_submit_count += 1;
        return self.sign_in_code_submit_succeeds;
    }

    fn deleteSignInCodeByte(_: *TestAuth) bool {
        return true;
    }

    fn appendSignInCodeByte(_: *TestAuth, _: std.mem.Allocator, _: u8) !bool {
        return true;
    }

    fn pickerView(_: *const TestAuth) auth_runtime.PickerView {
        return .{
            .active = false,
            .available_sources = .empty,
            .selected_choice = null,
            .active_source = null,
            .include_skip = false,
        };
    }

    fn refreshSelectedCredentialIfNeeded(
        self: *TestAuth,
        _: std.mem.Allocator,
    ) !auth_transition.CredentialChange {
        self.refresh_count += 1;
        if (self.refresh_error) |err| return err;
        if (self.credential_ready_after_refresh_count == self.refresh_count) self.credential_ready = true;
        return self.refresh_change;
    }

    fn credentialLease(self: *const TestAuth) ?types.CredentialLease {
        if (!self.credential_ready) return null;
        return .{ .direct = .{ .secret_bytes = "refreshed-key", .source = self.active_source } };
    }

    fn adoptPreparedCredential(
        self: *TestAuth,
        _: std.mem.Allocator,
        _: *credentials.Credential,
    ) auth_transition.CredentialChange {
        return self.refresh_change;
    }

    fn modelCatalogAccess(self: *const TestAuth) credentials.CatalogAccess {
        return if (self.catalog_ready)
            credentials.catalogAccessForCredential(.chatgpt_subscription, "refreshed-key")
        else
            .{ .public_only = .no_credential };
    }

    fn refreshSourceInventory(self: *TestAuth, _: std.mem.Allocator) !void {
        self.source_inventory_refresh_count += 1;
    }

    fn openOnboardingPicker(self: *TestAuth, _: std.mem.Allocator) void {
        self.picker_opened = true;
    }

    fn beginSourceInventoryRefresh(
        self: *TestAuth,
        _: std.mem.Allocator,
        action: auth_runtime.InventoryRefreshAction,
    ) auth_runtime.InventoryRefreshStart {
        if (self.inventory_refresh_action != null) return .busy;
        self.source_inventory_refresh_count += 1;
        self.inventory_refresh_action = action;
        return .started;
    }

    fn takeSourceInventoryRefresh(
        self: *TestAuth,
    ) ?auth_runtime.InventoryRefreshResult {
        const action = self.inventory_refresh_action orelse return null;
        self.inventory_refresh_action = null;
        return if (self.inventory_refresh_fails)
            .{ .failed = action }
        else
            .{ .ready = action };
    }

    fn recordCredentialFailure(
        self: *TestAuth,
        failure: auth_runtime.CredentialFailure,
        options: struct { notify: bool = true },
    ) bool {
        const same_failure = if (self.credential_failure) |current|
            current.source == failure.source and current.reason == failure.reason
        else
            false;
        if (!same_failure) {
            self.credential_failure = failure;
            self.credential_notice_claimed = false;
        }
        if (!options.notify or self.credential_notice_claimed) return false;
        self.credential_notice_claimed = true;
        return true;
    }

    fn credentialFailure(self: *const TestAuth) ?auth_runtime.CredentialFailure {
        return self.credential_failure;
    }

    fn openPichandworkorProvider(
        self: *TestAuth,
        _: std.mem.Allocator,
        provider: model_provider.ProviderId,
    ) void {
        self.picker_opened = true;
        self.picker_provider = provider;
    }

    fn closePicker(self: *TestAuth, _: std.mem.Allocator) void {
        self.picker_closed = true;
    }

    fn signInBrowserUrlAlloc(self: *TestAuth, alloc: std.mem.Allocator) !?[]u8 {
        const url = self.sign_in_url orelse return null;
        return try alloc.dupe(u8, url);
    }
};

const TestUsage = struct {
    refresh_count: usize = 0,
    clear_count: usize = 0,
    last_key: ?[]const u8 = null,

    fn replaceProviderReconciliationCredential(
        self: *TestUsage,
        _: std.mem.Allocator,
        _: model_provider.ProviderId,
        _: credentials.Source,
        _: ?[]const u8,
        api_key: []const u8,
    ) void {
        self.refresh_count += 1;
        self.last_key = api_key;
    }

    fn clearReconciliationCredential(self: *TestUsage) void {
        self.clear_count += 1;
        self.last_key = null;
    }
};

const TestRenderRequests = struct {
    footer_requested: bool = false,

    fn request(self: *TestRenderRequests, _: anytype) void {
        self.footer_requested = true;
    }
};

const TestUrlOpener = struct {
    calls: usize = 0,
    succeeds: bool = true,
    error_on_open: bool = false,
    opened_url: [256]u8 = undefined,
    opened_url_len: usize = 0,

    fn opener(self: *TestUrlOpener) host.UrlOpener {
        return .{
            .context = self,
            .open_fn = open,
        };
    }

    fn open(
        raw_context: ?*anyopaque,
        _: std.mem.Allocator,
        url: []const u8,
    ) host.UrlOpenError!bool {
        const self: *TestUrlOpener = @ptrCast(@alignCast(raw_context.?));
        self.calls += 1;
        if (url.len > self.opened_url.len) return error.OutOfMemory;
        @memcpy(self.opened_url[0..url.len], url);
        self.opened_url_len = url.len;
        if (self.error_on_open) return error.OutOfMemory;
        return self.succeeds;
    }

    fn openedUrl(self: *const TestUrlOpener) []const u8 {
        return self.opened_url[0..self.opened_url_len];
    }
};

const TestApp = struct {
    alloc: std.mem.Allocator = std.testing.allocator,
    submission: @import("input_submit_runtime.zig").State = .{},
    selected_provider: model_provider.ProviderId = .codex,
    auth: TestAuth = .{},
    input_runtime: @import("../input/runtime.zig").Runtime = .{},
    stream: struct { active: bool = false } = .{},
    worker: struct {
        queued_prompts: usize = 0,

        fn queuedPromptCount(self: @This()) usize {
            return self.queued_prompts;
        }
    } = .{},
    model_cache: TestModelCache = .{},
    session: struct {
        usage: TestUsage = .{},
    } = .{},
    model_cache_warmup_count: usize = 0,
    notice_write_count: usize = 0,
    transcript: std.ArrayList(u8) = .empty,
    test_url_opener: TestUrlOpener = .{},
    preference_write_count: usize = 0,
    last_preference_source: ?credentials.Source = null,
    preference_write_succeeds: bool = true,
    catalog_accepted: bool = true,
    shell: struct {
        render_requests: TestRenderRequests = .{},
    } = .{},

    fn deinit(self: *TestApp) void {
        self.input_runtime.deinit(self.alloc);
        self.transcript.deinit(self.alloc);
    }

    fn startModelCacheWarmup(self: *TestApp) void {
        self.model_cache_warmup_count += 1;
    }

    fn writeTranscriptClassified(self: *TestApp, text: []const u8, _: bool, _: anytype) !void {
        try self.transcript.appendSlice(self.alloc, text);
    }

    fn writeDomainNotice(self: *TestApp, notice: types.SemanticNotice, _: bool) !void {
        self.notice_write_count += 1;
        try self.transcript.appendSlice(self.alloc, notice.body);
        try self.transcript.append(self.alloc, '\n');
    }

    fn flushBeforeBlockingExternalWork(_: *TestApp) !void {}

    fn urlOpener(self: *TestApp) host.UrlOpener {
        return self.test_url_opener.opener();
    }

    fn persistCredentialSourcePreference(self: *TestApp, source: credentials.Source) void {
        self.preference_write_count += 1;
        if (self.preference_write_succeeds) self.last_preference_source = source;
    }

    fn providerCatalog(self: *TestApp, _: model_provider.ProviderId) ?model_catalog.Provider {
        return .{ .context = self, .fetch_fn = fetchTestCatalog };
    }

    fn fetchTestCatalog(raw: ?*anyopaque, _: std.mem.Allocator, _: model_catalog.FetchInput) std.mem.Allocator.Error!model_catalog.ProviderResult {
        const self: *TestApp = @ptrCast(@alignCast(raw.?));
        if (!self.catalog_accepted) {
            return .{ .failure = .{ .category = .authentication } };
        }
        var entries: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
        errdefer model_catalog.freeModelCatalog(self.alloc, &entries);
        try entries.append(self.alloc, .{
            .id = try self.alloc.dupe(u8, "test/model"),
            .model_type = try self.alloc.dupe(u8, "language"),
        });
        return .{ .catalog = entries };
    }
};

test "login prepares the inline picker before its asynchronous inventory refresh completes" {
    var app: TestApp = .{ .selected_provider = .grok };
    defer app.deinit();

    try Runtime(TestApp).runLoginCommand(&app);

    try std.testing.expectEqual(@as(usize, 1), app.auth.source_inventory_refresh_count);
    try std.testing.expect(!app.auth.picker_opened);
    const action = app.auth.inventory_refresh_action orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(model_provider.ProviderId.grok, action.provider);
    try std.testing.expectEqual(auth_runtime.InventoryRefreshDestination.provider_picker_command, action.destination);
    try Runtime(TestApp).collectSourceInventoryFacts(&app);
    try std.testing.expect(!app.auth.picker_opened);
    try std.testing.expect(app.shell.render_requests.footer_requested);
}

test "provider picker preserves type-ahead cursor undo and dismissal through inventory completion" {
    for ([_]bool{ false, true }) |login| {
        var app: TestApp = .{};
        defer app.deinit();
        if (login) {
            try Runtime(TestApp).runLoginCommand(&app);
        } else {
            try Runtime(TestApp).runProviderCommand(&app);
        }
        const prefix = picker_state.provider_prefix;
        try std.testing.expectEqualStrings(prefix, app.input_runtime.edit_state.input.items);
        try app.input_runtime.insertionState().insertSlice(app.alloc, "codex", .preserve);
        _ = app.input_runtime.edit_state.setCursor(prefix.len + 2);
        app.input_runtime.picker.dismissInlinePicker(.provider);

        try Runtime(TestApp).collectSourceInventoryFacts(&app);

        try std.testing.expectEqualStrings("/provider codex", app.input_runtime.edit_state.input.items);
        try std.testing.expectEqual(prefix.len + 2, app.input_runtime.edit_state.cursor);
        try std.testing.expect(app.input_runtime.picker.isInlinePickerDismissed(.provider));
        try std.testing.expect(try app.input_runtime.undoState().undo(app.alloc));
        try std.testing.expectEqualStrings(prefix, app.input_runtime.edit_state.input.items);
    }
}

test "provider inventory completion does not reclaim a changed composer" {
    for ([_]bool{ false, true }) |fails| {
        var app: TestApp = .{};
        defer app.deinit();
        app.auth.inventory_refresh_fails = fails;
        try Runtime(TestApp).runProviderCommand(&app);
        try app.input_runtime.textReplacementState().replace(app.alloc, "/model other");
        _ = app.input_runtime.edit_state.setCursor(8);

        try Runtime(TestApp).collectSourceInventoryFacts(&app);

        try std.testing.expectEqualStrings("/model other", app.input_runtime.edit_state.input.items);
        try std.testing.expectEqual(@as(usize, 8), app.input_runtime.edit_state.cursor);
        try std.testing.expect(!app.input_runtime.picker.isInlinePickerSuppressed(.provider));
    }
}

test "provider picker preparation failure starts no inventory task" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    var app: TestApp = .{ .alloc = failing.allocator() };
    defer app.deinit();

    try std.testing.expectError(error.OutOfMemory, Runtime(TestApp).runProviderCommand(&app));
    try std.testing.expectEqual(@as(usize, 0), app.auth.source_inventory_refresh_count);
    try std.testing.expect(app.auth.inventory_refresh_action == null);
}

test "provider picker repeated opening preserves input while inventory is pending" {
    var app: TestApp = .{};
    defer app.deinit();
    try Runtime(TestApp).runProviderCommand(&app);
    try app.input_runtime.insertionState().insertSlice(app.alloc, "codex", .preserve);

    try Runtime(TestApp).runLoginCommand(&app);
    try std.testing.expectEqual(@as(usize, 1), app.auth.source_inventory_refresh_count);
    try std.testing.expectEqualStrings("/provider codex", app.input_runtime.edit_state.input.items);
    try Runtime(TestApp).collectSourceInventoryFacts(&app);
    try std.testing.expectEqualStrings("/provider codex", app.input_runtime.edit_state.input.items);
    try std.testing.expectEqual(@as(usize, 1), app.notice_write_count);
}

test "provider picker stays dismissed when work starts during inventory refresh" {
    for ([_]bool{ false, true }) |active| {
        var app: TestApp = .{};
        defer app.deinit();
        try Runtime(TestApp).runProviderCommand(&app);
        try app.input_runtime.insertionState().insertSlice(app.alloc, "codex", .preserve);
        app.stream.active = active;
        app.worker.queued_prompts = if (active) 0 else 1;

        try Runtime(TestApp).collectSourceInventoryFacts(&app);

        try std.testing.expectEqualStrings("/provider codex", app.input_runtime.edit_state.input.items);
        try std.testing.expect(app.input_runtime.picker.isInlinePickerDismissed(.provider));
        try std.testing.expectEqual(@as(usize, 1), app.notice_write_count);
    }
}

test "provider picker rejects active and queued work before refreshing inventory" {
    const cases = [_]struct { active: bool, queued: usize }{
        .{ .active = true, .queued = 0 },
        .{ .active = false, .queued = 1 },
    };
    for (cases) |case| {
        for ([_]bool{ false, true }) |login| {
            var app: TestApp = .{};
            defer app.deinit();
            app.stream.active = case.active;
            app.worker.queued_prompts = case.queued;
            try app.input_runtime.textReplacementState().replace(app.alloc, "existing draft");

            if (login) {
                try Runtime(TestApp).runLoginCommand(&app);
            } else {
                try Runtime(TestApp).runProviderCommand(&app);
            }
            try Runtime(TestApp).collectSourceInventoryFacts(&app);

            try std.testing.expectEqual(@as(usize, 0), app.auth.source_inventory_refresh_count);
            try std.testing.expect(app.auth.inventory_refresh_action == null);
            try std.testing.expectEqualStrings("existing draft", app.input_runtime.edit_state.input.items);
            try std.testing.expectEqual(@as(usize, 1), app.notice_write_count);
            try std.testing.expectEqualStrings(provider_busy_message ++ "\n", app.transcript.items);
        }
    }
}

test "provider picker rechecks work before publishing a completed refresh" {
    const cases = [_]struct { active: bool, queued: usize }{
        .{ .active = true, .queued = 0 },
        .{ .active = false, .queued = 1 },
    };
    for (cases) |case| {
        for ([_]bool{ false, true }) |login| {
            var app: TestApp = .{};
            defer app.deinit();
            if (login) {
                try Runtime(TestApp).runLoginCommand(&app);
            } else {
                try Runtime(TestApp).runProviderCommand(&app);
            }
            try std.testing.expectEqual(@as(usize, 1), app.auth.source_inventory_refresh_count);
            app.stream.active = case.active;
            app.worker.queued_prompts = case.queued;
            try app.input_runtime.textReplacementState().replace(app.alloc, "new draft");

            try Runtime(TestApp).collectSourceInventoryFacts(&app);

            try std.testing.expect(app.auth.inventory_refresh_action == null);
            try std.testing.expectEqualStrings("new draft", app.input_runtime.edit_state.input.items);
            try std.testing.expectEqual(@as(usize, 1), app.notice_write_count);
            try std.testing.expectEqualStrings(provider_busy_message ++ "\n", app.transcript.items);

            app.stream.active = false;
            app.worker.queued_prompts = 0;
            if (login) {
                try Runtime(TestApp).runLoginCommand(&app);
            } else {
                try Runtime(TestApp).runProviderCommand(&app);
            }
            try Runtime(TestApp).collectSourceInventoryFacts(&app);
            try std.testing.expectEqualStrings(
                picker_state.provider_prefix,
                app.input_runtime.edit_state.input.items,
            );
            try std.testing.expectEqual(@as(usize, 1), app.notice_write_count);
        }
    }
}

test "login inventory failure leaves the picker closed and reports one error" {
    var app: TestApp = .{ .selected_provider = .codex };
    defer app.deinit();
    app.auth.inventory_refresh_fails = true;

    try Runtime(TestApp).runLoginCommand(&app);
    try app.input_runtime.insertionState().insertSlice(app.alloc, "codex", .preserve);
    try Runtime(TestApp).collectSourceInventoryFacts(&app);
    try Runtime(TestApp).collectSourceInventoryFacts(&app);

    try std.testing.expect(!app.auth.picker_opened);
    try std.testing.expectEqualStrings("/provider codex", app.input_runtime.edit_state.input.items);
    try std.testing.expect(app.input_runtime.picker.isInlinePickerDismissed(.provider));
    try std.testing.expectEqual(@as(usize, 1), app.notice_write_count);
    try std.testing.expect(std.mem.find(
        u8,
        app.transcript.items,
        "picker was not opened with stale data",
    ) != null);
}

test "OAuth app gating accepts native auth or JS-host auth and rejects neither" {
    const NativeApp = struct {
        pub const host_profile = runtime_profile.native;
    };
    const JsHostApp = struct {
        pub const host_profile = runtime_profile.wasm;
    };
    const NeitherApp = struct {
        pub const host_profile = blk: {
            var profile = runtime_profile.wasm;
            profile.js_host_auth = false;
            break :blk profile;
        };
    };

    try std.testing.expect(oauthAuthEnabled(NativeApp));
    try std.testing.expect(oauthAuthEnabled(JsHostApp));
    try std.testing.expect(!oauthAuthEnabled(NeitherApp));
}

test "interactive sign-in opens the owned browser URL through the host" {
    var app: TestApp = .{};
    app.auth.sign_in_url = "https://handwork.test/verify?code=TEST-CODE";

    try Runtime(TestApp).openSignInBrowser(&app);

    try std.testing.expectEqual(@as(usize, 1), app.test_url_opener.calls);
    try std.testing.expectEqualStrings(
        "https://handwork.test/verify?code=TEST-CODE",
        app.test_url_opener.openedUrl(),
    );
}

test "interactive sign-in routes Tab to the auth-owned manual code toggle" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.sign_in_entry_active = true;
    app.auth.sign_in_url = "https://issuer.test/authorize";

    try std.testing.expect(try Runtime(TestApp).routeAuthPickerByte(&app, '\t'));

    try std.testing.expectEqual(@as(usize, 1), app.auth.sign_in_code_toggle_count);
    try std.testing.expect(app.auth.sign_in_code_entry_active);
    try std.testing.expectEqual(@as(usize, 0), app.test_url_opener.calls);
    try std.testing.expect(app.shell.render_requests.footer_requested);
}

test "interactive hidden manual code paste reveals entry for the paste owner" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.sign_in_entry_active = true;

    try std.testing.expect(!Runtime(TestApp).routeAuthPickerEscapeAction(&app, .paste_start));

    try std.testing.expectEqual(@as(usize, 1), app.auth.sign_in_code_toggle_count);
    try std.testing.expect(app.auth.sign_in_code_entry_active);
    try std.testing.expect(app.shell.render_requests.footer_requested);
}

test "interactive sign-in without manual fallback consumes hidden paste" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.sign_in_entry_active = true;
    app.auth.sign_in_code_toggle_succeeds = false;

    try std.testing.expect(Runtime(TestApp).routeAuthPickerEscapeAction(&app, .paste_start));

    try std.testing.expectEqual(@as(usize, 1), app.auth.sign_in_code_toggle_count);
    try std.testing.expect(!app.auth.sign_in_code_entry_active);
    try std.testing.expect(!app.shell.render_requests.footer_requested);
}

test "interactive manual code entry never reopens the browser on empty submit" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.sign_in_entry_active = true;
    app.auth.sign_in_code_entry_active = true;
    app.auth.sign_in_code_submit_succeeds = false;
    app.auth.sign_in_url = "https://issuer.test/authorize";

    try std.testing.expect(try Runtime(TestApp).routeAuthPickerByte(&app, '\r'));

    try std.testing.expectEqual(@as(usize, 1), app.auth.sign_in_code_submit_count);
    try std.testing.expectEqual(@as(usize, 0), app.test_url_opener.calls);
}

test "interactive sign-in preserves manual fallback when the host launcher fails" {
    var app: TestApp = .{};
    app.auth.sign_in_url = "https://handwork.test/verify";
    app.test_url_opener.succeeds = false;

    try Runtime(TestApp).openSignInBrowser(&app);

    try std.testing.expectEqual(@as(usize, 1), app.test_url_opener.calls);
    try std.testing.expectEqualStrings(
        "https://handwork.test/verify",
        app.test_url_opener.openedUrl(),
    );
    try std.testing.expectEqualStrings("https://handwork.test/verify", app.auth.sign_in_url.?);
}

test "interactive sign-in frees its browser URL when the host opener errors" {
    var app: TestApp = .{};
    app.auth.sign_in_url = "https://handwork.test/verify";
    app.test_url_opener.error_on_open = true;

    try std.testing.expectError(
        error.OutOfMemory,
        Runtime(TestApp).openSignInBrowser(&app),
    );
    try std.testing.expectEqual(@as(usize, 1), app.test_url_opener.calls);
}

test "prompt credential refresh preserves catalog for secret rotation" {
    var app: TestApp = .{};
    defer app.deinit();
    const runtime = Runtime(TestApp);

    try runtime.refreshSelectedCredentialIfNeeded(&app);
    try std.testing.expectEqual(@as(usize, 1), app.auth.refresh_count);
    try std.testing.expectEqual(@as(usize, 0), app.model_cache.reset_count);

    app.auth.refresh_change = .secret_only;
    try runtime.refreshSelectedCredentialIfNeeded(&app);
    try std.testing.expectEqual(@as(usize, 2), app.auth.refresh_count);
    try std.testing.expectEqual(@as(usize, 0), app.model_cache.reset_count);
    try std.testing.expectEqual(@as(usize, 1), app.model_cache_warmup_count);
    try std.testing.expectEqual(@as(usize, 1), app.session.usage.refresh_count);

    app.auth.refresh_change = .authority;
    try runtime.refreshSelectedCredentialIfNeeded(&app);
    try std.testing.expectEqual(@as(usize, 3), app.auth.refresh_count);
    try std.testing.expectEqual(@as(usize, 1), app.model_cache.reset_count);
    try std.testing.expectEqual(@as(usize, 2), app.model_cache_warmup_count);
    try std.testing.expectEqual(@as(usize, 2), app.session.usage.refresh_count);
}

test "credential removal clears the reconciliation credential" {
    var app: TestApp = .{};
    app.auth.credential_ready = false;

    Runtime(TestApp).applyCredentialChange(&app, true);

    try std.testing.expectEqual(@as(usize, 1), app.session.usage.clear_count);
    try std.testing.expectEqual(@as(usize, 0), app.session.usage.refresh_count);
}

test "prompt credential refresh failure is recoverable and detail-free" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.refresh_error = error.OAuthRequestFailed;

    try std.testing.expect(!try Runtime(TestApp).preparePromptCredential(&app));
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "Codex subscription credential refresh failed.") != null);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "press enter to retry.") != null);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "Your prompt is saved.") != null);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "Choose another source") == null);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "OAuthRequestFailed") == null);
    try std.testing.expect(app.shell.render_requests.footer_requested);
    try std.testing.expectEqual(@as(usize, 0), app.auth.source_inventory_refresh_count);
    try std.testing.expect(app.auth.credential_failure != null);
    try std.testing.expect(!app.auth.picker_opened);
    try std.testing.expectEqual(@as(usize, 0), app.model_cache.reset_count);
}

test "prompt credential admission retries a crossed readiness deadline" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.credential_ready = false;
    app.auth.credential_ready_after_refresh_count = 2;

    try std.testing.expect(try Runtime(TestApp).preparePromptCredential(&app));
    try std.testing.expectEqual(@as(usize, 2), app.auth.refresh_count);
    try std.testing.expectEqual(@as(usize, 0), app.transcript.items.len);
    try std.testing.expect(!app.auth.picker_opened);
}

test "prompt credential admission rejects a credential that remains unavailable" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.credential_ready = false;

    try std.testing.expect(!try Runtime(TestApp).preparePromptCredential(&app));
    try std.testing.expectEqual(@as(usize, 2), app.auth.refresh_count);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "Codex subscription sign-in expired.") != null);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "press enter to sign in again.") != null);
    try std.testing.expect(std.mem.find(u8, app.transcript.items, "Your prompt is saved.") != null);
    try std.testing.expect(!app.auth.picker_opened);
}

test "prompt credential refresh allows only OutOfMemory to escape" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.refresh_error = error.OutOfMemory;

    try std.testing.expectError(error.OutOfMemory, Runtime(TestApp).preparePromptCredential(&app));
    try std.testing.expectEqual(@as(usize, 0), app.transcript.items.len);
    try std.testing.expect(!app.shell.render_requests.footer_requested);
    try std.testing.expectEqual(@as(usize, 0), app.auth.source_inventory_refresh_count);
    try std.testing.expect(!app.auth.picker_opened);
}

test "manual compaction missing credentials leave transcript feedback to its owner" {
    for ([_]model_provider.ProviderId{ .codex, .grok }) |provider| {
        for ([_]bool{ false, true }) |for_compaction| {
            var app: TestApp = .{};
            defer app.deinit();
            app.auth.active_source = null;
            app.auth.onboarding_skipped = true;
            app.submission.compaction_pending = for_compaction;

            try std.testing.expect(!try Runtime(TestApp).missingPromptCredential(&app, provider));
            try std.testing.expectEqual(@as(usize, if (for_compaction) 0 else 1), app.notice_write_count);
            try std.testing.expectEqual(for_compaction, app.transcript.items.len == 0);
            try std.testing.expect(!app.auth.picker_opened);
        }
    }
}

test "manual compaction missing credentials keeps provider sign-in under its lifecycle owner" {
    var app: TestApp = .{};
    defer app.deinit();
    app.auth.active_source = null;
    app.submission.compaction_pending = true;

    try std.testing.expect(!try Runtime(TestApp).missingPromptCredential(&app, .codex));
    try std.testing.expect(!app.auth.picker_opened);
    try std.testing.expectEqual(@as(usize, 0), app.auth.source_inventory_refresh_count);
    try std.testing.expectEqual(@as(usize, 0), app.notice_write_count);
}
