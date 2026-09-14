const std = @import("std");
const command_specs = @import("../core/slash_commands/command_specs.zig");

const Allocator = std.mem.Allocator;

pub const TopLevelKind = command_specs.TopLevelKind;
pub const TopLevelSpec = command_specs.TopLevelSpec;
pub const TopLevelHelpEntry = command_specs.TopLevelHelpEntry;
pub const TopLevelHelpGroup = command_specs.TopLevelHelpGroup;
pub const TopLevelFlag = command_specs.TopLevelFlag;
pub const TopLevelExample = command_specs.TopLevelExample;
pub const TopLevelResource = command_specs.TopLevelResource;
pub const TopLevelRegistry = command_specs.TopLevelRegistry;
pub const HelpStyle = command_specs.HelpStyle;
pub const SlashKind = command_specs.SlashKind;
pub const SlashPresentationCategory = command_specs.SlashPresentationCategory;
pub const SlashSpec = command_specs.SlashSpec;
pub const SlashRegistry = command_specs.SlashRegistry;

const json_option = command_specs.OptionDoc{ .flag = "--json", .description = "Emit machine-readable JSON instead of text" };

pub const top_level_specs = [_]TopLevelSpec{
    .{
        .kind = .help,
        .token = "help",
        .aliases = &.{ "--help", "-h" },
        .usage = "help",
        .summary = "Show this help",
    },
    .{
        .kind = .ask,
        .token = "ask",
        .usage = "ask [--auto|--full-access] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--no-save] [--no-color] [--resume <last|id>|--resume-id <id>] [--continue-recovery] [--] <prompt>",
        .summary = "Run one noninteractive request",
        .options = &.{
            .{ .flag = "--auto", .description = "Automatically review unresolved permission requests" },
            .{ .flag = "--full-access", .description = "Disable handwork permission checks" },
            .{ .flag = "--yolo", .description = "Alias for --full-access" },
            .{ .flag = "--image PATH", .description = "Attach an image file; repeat for multiple images" },
            .{ .flag = "--system TEXT", .description = "Replace the built-in system prompt for this request" },
            json_option,
            .{ .flag = "--quiet", .description = "Suppress assistant output" },
            .{ .flag = "--prompt-permissions", .description = "Prompt for Y/N permission approval when stdin is a TTY" },
            .{ .flag = "--no-save", .description = "Do not save the session; incompatible with --resume and --resume-id" },
            .{ .flag = "--no-color", .description = "Render TTY output without colors or hyperlinks" },
            .{ .flag = "--resume <last|id>", .description = "Continue the last session or a session by id" },
            .{ .flag = "--resume-id <id>", .description = "Continue a session by exact id" },
            .{ .flag = "--continue-recovery", .description = "Resume the paused model response in the selected session" },
            .{ .flag = "--", .description = "Treat every following argument as prompt text" },
        },
        .details = &.{
            "The prompt may be passed as arguments or piped on stdin when no prompt args are given.",
            "TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.",
            "Operational progress and diagnostics are written to stderr. JSON `output` keeps accumulated assistant Markdown; `final_output` contains only the completed final response, or an empty string when absent.",
            "JSON usage sums reported main-agent input_tokens and output_tokens, including with --no-save; unreported counts are null. Nested usage and dollar spend are excluded.",
            "--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.",
            "With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.",
        },
    },
    .{
        .kind = .acp,
        .token = "acp",
        .usage = "acp [--model <id>] [--log-file <path>]",
        .summary = "Start an ACP server over stdio",
        .options = &.{
            .{ .flag = "--model <id>", .description = "Override the default model" },
            .{ .flag = "--log-file <path>", .description = "Write ACP logs to a file" },
        },
    },
    .{
        .kind = .pr,
        .token = "pr",
        .usage = "pr [--auto] [--create] [context]",
        .summary = "Draft or publish a pull request",
        .options = &.{
            .{ .flag = "--auto", .description = "Automatically review unresolved permission requests" },
            .{ .flag = "--create", .description = "Publish the drafted pull request via the GitHub CLI" },
        },
        .details = &.{
            "Must run inside a git repository. Without --create, the drafted PR is printed only.",
        },
    },
    .{
        .kind = .issue,
        .token = "issue",
        .usage = "issue [--auto] [--create] [context]",
        .summary = "Draft or publish a GitHub issue",
        .options = &.{
            .{ .flag = "--auto", .description = "Automatically review unresolved permission requests" },
            .{ .flag = "--create", .description = "Publish the drafted issue via the GitHub CLI" },
        },
    },
    .{ .kind = .runtime, .token = "runtime", .usage = "runtime <codex|copilot> <login|models|ask>", .summary = "Use an official subscription agent runtime" },
    .{
        .kind = .login,
        .token = "login",
        .usage = "login [provider]",
        .summary = "Connect a model provider",
    },
    .{
        .kind = .logout,
        .token = "logout",
        .usage = "logout [provider]",
        .summary = "Sign out of a subscription provider session",
    },
    .{
        .kind = .status,
        .token = "status",
        .usage = "status [--json]",
        .summary = "Show configuration and runtime information",
        .options = &.{json_option},
    },
    .{
        .kind = .permissions,
        .token = "permissions",
        .usage = "permissions [--json]",
        .summary = "Show the permission mode and rules",
        .options = &.{json_option},
        .details = &.{
            "Modes:",
            "  ask          Prompt before sensitive tool calls",
            "  auto         Apply rules, then review unresolved sensitive tool calls (default)",
            "  full-access  Disable handwork permission checks",
            "",
            "Change the mode from the interactive shell with `/permissions [ask|auto|full-access|reset]`,",
            "and manage persistent allow rules with `/allowlist`.",
        },
    },
    .{
        .kind = .mcp,
        .token = "mcp",
        .usage = "mcp <command> ...",
        .summary = "Manage MCP servers without opening the interactive shell",
        .details = &.{
            "Commands:",
            "  handwork mcp add NAME COMMAND [ARGS...]",
            "  handwork mcp add --transport http NAME URL",
            "  handwork " ++ command_specs.mcp_auth_usage,
            "  handwork mcp list [--connect]",
            "  handwork mcp logout NAME",
            "  handwork mcp path",
            "  handwork mcp remove NAME",
            "  handwork mcp trust approve|reject NAME",
            "  handwork mcp trust approve-all|reset",
            "",
            "By default, list reads configuration without opening MCP transports.",
            "Use --connect to connect and discover servers before rendering health.",
        },
    },
    .{
        .kind = .models,
        .token = "models",
        .usage = "models [--json]",
        .summary = "List available models",
        .options = &.{json_option},
    },
    .{
        .kind = .provider,
        .token = "provider",
        .usage = "provider <provider>",
        .summary = "Choose the model provider used by handwork",
    },
    .{
        .kind = .doctor,
        .token = "doctor",
        .usage = "doctor [--json]",
        .summary = "Run local health and preflight checks",
        .options = &.{json_option},
    },
    .{
        .kind = .session,
        .token = "session",
        .usage = "session <last|id>|--id <id> [--json] | session resume [last|<id>] | session resume --id <id> | session migrate <id>|--id <id> [--allow-large] [--json] | session recover <id>|--id <id> [--json]",
        .summary = "Inspect, resume, migrate, or recover saved sessions",
        .options = &.{
            .{ .flag = "last", .description = "Inspect the current workspace session" },
            .{ .flag = "--id <id>", .description = "Inspect a saved session by exact id" },
            .{ .flag = "resume [last|<id>]", .description = "Resume the latest workspace session or a session by id" },
            .{ .flag = "migrate <id>", .description = "Migrate a saved session to the current format" },
            .{ .flag = "recover <id>", .description = "Copy a recoverable corrupt session into a new session" },
            .{ .flag = "--allow-large", .description = "Permit migrating an oversized session" },
            json_option,
        },
    },
    .{
        .kind = .sessions,
        .token = "sessions",
        .usage = "sessions [--all] [--limit <1-100>] [--cursor <cursor>] [--json]",
        .summary = "List saved sessions for the current workspace",
        .options = &.{
            .{ .flag = "--all", .description = "List saved sessions across every workspace in this profile" },
            .{ .flag = "--limit <1-100>", .description = "Set the maximum sessions returned per page" },
            .{ .flag = "--cursor <cursor>", .description = "Continue from a prior sessions result" },
            json_option,
        },
    },
    .{
        .kind = .@"resume",
        .token = "resume",
        .aliases = &.{ "--resume", "--resume-last", "--continue", "-c", "-r" },
        .hidden_from_top_level_help = true,
        .usage = "session resume [last|<id>] | session resume --id <id> | --resume [last|<id>] | resume [last|<id>] | resume --id <id> | --resume-last | --continue | -c | -r | --resume-<id>",
        .summary = "Continue a saved interactive session",
        .options = &.{
            .{ .flag = "-r", .description = "Choose the session to resume from a picker" },
            .{ .flag = "last", .description = "Resume the most recent session" },
            .{ .flag = "<id>", .description = "Resume a session by id" },
            .{ .flag = "--id <id>", .description = "Resume a session by exact id" },
        },
    },
    .{
        .kind = .usage,
        .token = "usage",
        .usage = "usage [--period <24h|7d|30d>] [--json]",
        .summary = "Show local handwork token usage and spend",
        .options = &.{
            .{ .flag = "--period <24h|7d|30d>", .description = "Select a rolling window (default: 30d)" },
            json_option,
        },
        .details = &.{
            "Reports only usage recorded by handwork on this machine.",
            "This command reads local session usage.",
        },
    },
    .{
        .kind = .upgrade,
        .token = "upgrade",
        .aliases = &.{"update"},
        .usage = "upgrade [--channel <stable|dev>] [--json]",
        .summary = "Update handwork (alias: update); npm installs use npm",
        .options = &.{
            .{ .flag = "--channel <stable|dev>", .description = "Select and remember the release channel" },
            json_option,
        },
    },
    .{
        .kind = .replay,
        .token = "replay",
        .usage = "replay <tape> [--frames] [--json] [--golden <path>] [--frames-dir <path>]",
        .summary = "Replay a recorded terminal session",
        .hidden_from_top_level_help = true,
        .options = &.{
            .{ .flag = "--frames", .description = "Render each captured frame" },
            .{ .flag = "--golden <path>", .description = "Write the final rendered grid to a file" },
            .{ .flag = "--frames-dir <path>", .description = "Write rendered frames to a directory" },
            json_option,
        },
    },
    .{
        .kind = .workspace,
        .token = "workspace",
        .usage = "workspace [list|add PATH|remove PATH|clear] [--json]",
        .summary = "Manage additional workspace directories",
        .options = &.{
            .{ .flag = "list", .description = "List the primary and additional directories (default)" },
            .{ .flag = "add PATH", .description = "Persist an existing additional directory" },
            .{ .flag = "remove PATH", .description = "Remove an additional directory" },
            .{ .flag = "clear", .description = "Remove all additional directories" },
            json_option,
        },
        .details = &.{
            "Additional directories are stored for the current primary workspace.",
        },
    },
};

pub const top_level_help_default_width = command_specs.top_level_help_default_width;
pub const top_level_help_fast_buffer_bytes: usize = 32 * 1024;

pub const top_level_help_groups = [_]TopLevelHelpGroup{
    .{ .entries = &.{
        .{ .kind = .ask, .usage = "ask <prompt>" },
    } },
    .{ .entries = &.{
        .{ .kind = .pr, .usage = "pr [context]" },
        .{ .kind = .issue, .usage = "issue [context]" },
    } },
    .{ .entries = &.{
        .{ .kind = .sessions, .usage = "sessions" },
        .{ .kind = .session, .usage = "session <last|id>" },
        .{ .usage = "session resume [last|id]", .summary = "Resume the latest workspace session or a session by id" },
        .{ .usage = "session migrate <id>", .summary = "Migrate a saved session to the current format" },
        .{ .usage = "session recover <id>", .summary = "Copy a recoverable corrupt session" },
    } },
    .{ .entries = &.{
        .{ .kind = .runtime, .usage = "runtime <codex|copilot> ...", .summary = "Use an official subscription agent runtime" },
        .{ .kind = .login, .usage = "login [provider]", .summary = "Sign in to a model provider" },
        .{ .kind = .logout, .usage = "logout [provider]", .summary = "Sign out of a model provider" },
        .{ .kind = .provider, .usage = "provider <provider>", .summary = "Choose the active model provider" },
        .{ .kind = .models, .usage = "models" },
    } },
    .{ .entries = &.{
        .{ .kind = .usage, .usage = "usage [--period <24h|7d|30d>]", .summary = "Show locally recorded token usage and spend" },
    } },
    .{ .entries = &.{
        .{ .kind = .status, .usage = "status" },
        .{ .kind = .doctor, .usage = "doctor" },
        .{ .kind = .mcp, .usage = "mcp <command> ..." },
        .{ .kind = .permissions, .usage = "permissions" },
        .{ .kind = .workspace, .usage = "workspace" },
        .{ .kind = .upgrade, .usage = "upgrade", .summary = "Upgrade handwork on the selected release channel" },
        .{ .kind = .acp, .usage = "acp" },
        .{ .kind = .help, .usage = "help" },
    } },
};

pub const top_level_flags = [_]TopLevelFlag{
    .{
        .usage = "--context-limit <spec>",
        .description = "Set name=bytes|off; repeatable",
    },
    .{
        .usage = "--add-dir <path>",
        .description = "Add a workspace directory; repeatable",
    },
    .{
        .usage = "--no-additional-dirs",
        .description = "Ignore saved additional directories",
    },
    .{
        .usage = "-c, --continue",
        .description = "Resume the remembered workspace session",
    },
    .{
        .usage = "-r",
        .description = "Open the saved-session picker",
    },
    .{
        .usage = "--resume [last|<id>]",
        .description = "Resume the latest workspace session or an exact ID",
    },
    .{
        .usage = "--resume-last",
        .description = "Resume the latest workspace session",
    },
    .{
        .usage = "--resume-<id>",
        .description = "Resume a session by exact ID",
    },
    .{
        .usage = "-h, --help",
        .description = "Display this help and exit",
    },
    .{
        .usage = "-v, --version",
        .description = "Print the handwork version and exit",
    },
};

pub const top_level_examples = [_]TopLevelExample{
    .{ .command = "handwork", .description = "Start a fresh interactive session" },
    .{ .command = "handwork ask \"Explain the changes in this repository\"", .description = "Run one request and exit" },
    .{ .command = "handwork session resume last", .description = "Continue the latest session for this workspace" },
    .{ .command = "handwork status --json", .description = "Inspect the current configuration as JSON" },
};

pub const top_level_notes = [_][]const u8{
    "Run `handwork <command> --help` for command-specific usage and options.",
    "Run `/help` inside an interactive session for slash commands.",
};

pub const top_level_resources = [_]TopLevelResource{
    .{ .label = "Created by:", .value = "Connor Love · connorlove.com", .link = false },
    .{ .label = "Learn more about handwork:", .value = "https://connorlove.com", .link = true },
    .{ .label = "Report a problem:", .value = "run `/feedback` inside handwork" },
};

pub const top_level_registry = TopLevelRegistry{
    .specs = top_level_specs[0..],
    .description = "Fast, native coding agent for the terminal.",
    .interactive_hint = "handwork starts an interactive session by default. Use `handwork ask` to run one noninteractive request.",
    .help_groups = top_level_help_groups[0..],
    .flags = top_level_flags[0..],
    .examples = top_level_examples[0..],
    .notes = top_level_notes[0..],
    .resources = top_level_resources[0..],
};

pub fn matchesTopLevel(token: []const u8, kind: TopLevelKind) bool {
    return command_specs.matchesTopLevel(top_level_registry, token, kind);
}

pub fn renderTopLevelHelp(alloc: Allocator, columns: usize, version: []const u8) ![]u8 {
    return command_specs.renderTopLevelHelp(alloc, top_level_registry, columns, version);
}

pub fn renderTopLevelHelpWithStyle(alloc: Allocator, columns: usize, version: []const u8, style: HelpStyle) ![]u8 {
    return command_specs.renderTopLevelHelpWithStyle(alloc, top_level_registry, columns, version, style);
}

pub fn renderTopLevelCommandHelp(alloc: Allocator, kind: TopLevelKind) ![]u8 {
    return command_specs.renderTopLevelCommandHelp(alloc, top_level_registry, kind);
}

pub fn topLevelKindFromToken(token: []const u8) ?TopLevelKind {
    return command_specs.topLevelKindFromToken(top_level_registry, token);
}

pub fn topLevelUsage(kind: TopLevelKind) []const u8 {
    return command_specs.topLevelUsage(top_level_registry, kind);
}

pub const slash_specs = [_]SlashSpec{
    .{ .kind = .help, .command = "/help", .help_entry = "/help", .completion_description = "show available slash commands", .presentation_category = .general, .show_in_welcome = true },
    .{ .kind = .clear_screen, .command = "/clear", .aliases = &.{"/clear-chat"}, .show_aliases_in_completion = false, .help_entry = "/clear", .completion_description = "start a fresh conversation while keeping managed processes", .presentation_category = .general, .show_in_welcome = true },
    .{ .kind = .new_session, .command = "/new", .aliases = &.{"/new-session"}, .show_aliases_in_completion = false, .help_entry = "/new", .completion_description = "start a fresh session", .presentation_category = .session, .show_in_welcome = true },
    .{ .kind = .reset_session, .command = "/reset", .aliases = &.{"/reset-context"}, .show_aliases_in_completion = false, .help_entry = "/reset", .completion_description = "reset the current session context", .presentation_category = .session },
    .{ .kind = .resume_session, .command = "/resume", .help_entry = "/resume", .completion_description = "resume a saved session", .presentation_category = .session },
    .{ .kind = .continue_recovery, .command = "/continue", .help_entry = "/continue", .completion_description = "continue a paused model response", .presentation_category = .session, .requires_prompt_credential = true },
    .{ .kind = .rename_session, .command = "/rename", .help_entry = "/rename <title>", .completion_description = "rename the current session", .presentation_category = .session, .has_args = true, .accepts_payload = true },
    .{ .kind = .logout, .command = "/logout", .help_entry = "/logout [provider]", .completion_description = "sign out of a provider session", .presentation_category = .account, .has_args = true, .accepts_payload = true },
    .{ .kind = .provider, .command = "/provider", .aliases = &.{"/login"}, .help_entry = "/provider (/login)", .completion_description = "connect or switch a model provider", .presentation_category = .account, .has_args = true },
    .{ .kind = .stats, .command = "/stats", .help_entry = "/stats", .completion_description = "show token and turn statistics", .presentation_category = .account },
    .{ .kind = .usage, .command = "/usage", .aliases = &.{"/cost"}, .help_entry = "/usage (/cost)", .completion_description = "show local handwork tokens, models, and spend", .presentation_category = .account },
    .{ .kind = .status, .command = "/status", .help_entry = "/status", .completion_description = "show runtime configuration", .presentation_category = .general, .show_in_welcome = true },
    .{ .kind = .image, .command = "/image", .aliases = &.{"/img"}, .help_entry = "/image <path> (/img)", .completion_description = "attach an image by path", .presentation_category = .media, .has_args = true, .accepts_payload = true },
    .{ .kind = .images, .command = "/images", .help_entry = "/images [clear]", .completion_description = "manage pending image attachments", .presentation_category = .media, .has_args = true, .accepts_payload = true },
    .{ .kind = .reasoning, .command = "/reasoning", .aliases = &.{"/effor"}, .help_entry = "/reasoning [effort] (/effor)", .completion_description = "change reasoning effort for the current model", .presentation_category = .model, .has_args = true, .accepts_payload = true },
    .{ .kind = .model, .command = "/model", .help_entry = "/model <id-or-query>", .completion_description = "choose what model and reasoning effort to use", .presentation_category = .model, .has_args = true, .accepts_payload = true },
    .{ .kind = .permissions, .command = "/permissions", .help_entry = "/permissions [ask|auto|full-access|reset]", .completion_description = "choose what handwork is allowed to do", .presentation_category = .security, .show_in_welcome = true, .has_args = true, .accepts_payload = true },
    .{ .kind = .allowlist, .command = "/allowlist", .help_entry = "/allowlist [view [effective|local|user]|[local|user] add|remove|reset ...]", .completion_description = "manage trusted commands, tools, and URLs", .presentation_category = .security, .show_in_welcome = true, .has_args = true, .accepts_payload = true },
    .{ .kind = .undo, .command = "/undo", .aliases = &.{"/undo-file"}, .show_aliases_in_completion = false, .help_entry = "/undo", .completion_description = "undo the latest tracked file operation", .presentation_category = .session },
    .{ .kind = .mcp, .command = "/mcp", .help_entry = "/mcp [list|resource|prompt|add|remove|path|reload|auth|logout|trust]", .completion_description = "manage local and remote MCP servers, resources, prompts, and project trust", .presentation_category = .extensions, .has_args = true, .accepts_payload = true },
    .{ .kind = .skills, .command = "/skills", .help_entry = "/skills [list|add|install|show|create|remove|path] [name|url|path] ($ opens skill search)", .completion_description = "browse and manage skills", .presentation_category = .extensions, .has_args = true, .accepts_payload = true },
    .{ .kind = .copy, .command = "/copy", .help_entry = "/copy", .completion_description = "copy the last assistant response", .presentation_category = .session },
    .{ .kind = .feedback, .command = "/feedback", .help_entry = "/feedback", .completion_description = "open the handwork feedback form", .presentation_category = .product, .show_in_welcome = true },
    .{ .kind = .trace, .command = "/trace", .aliases = &.{"/debug-trace"}, .show_aliases_in_completion = false, .help_entry = "/trace", .completion_description = "copy a private diagnostic trace", .presentation_category = .product },
    .{ .kind = .diff, .command = "/diff", .help_entry = "/diff", .completion_description = "show staged and unstaged Git changes (excluding untracked files)", .presentation_category = .workspace },
    .{ .kind = .jobs, .command = "/jobs", .help_entry = "/jobs", .completion_description = "list managed commands and their current states", .presentation_category = .workspace },
    .{ .kind = .export_session, .command = "/export", .help_entry = "/export [path]", .completion_description = "save retained conversation text as a new private Markdown file", .presentation_category = .session, .has_args = true, .accepts_payload = true },
    .{ .kind = .doctor, .command = "/doctor", .help_entry = "/doctor", .completion_description = "check local configuration, authentication, and tooling", .presentation_category = .product },
    .{ .kind = .context, .command = "/context", .help_entry = "/context", .completion_description = "show last reported context usage without changing history or limits", .presentation_category = .session },
    .{ .kind = .compact, .command = "/compact", .help_entry = "/compact", .completion_description = "summarize context into a fresh window", .presentation_category = .session },
    .{ .kind = .settings, .command = "/settings", .help_entry = "/settings [startup-scrollback [on|off]]", .completion_description = "browse and update settings", .presentation_category = .appearance, .has_args = true, .accepts_payload = true },
    .{ .kind = .alias, .command = "/alias", .aliases = &.{}, .help_entry = "/alias [name] [command]", .completion_description = "show alias availability", .presentation_category = .extensions, .has_args = true, .accepts_payload = true },
    .{ .kind = .paste, .command = "/paste", .aliases = &.{"/paste-image"}, .show_aliases_in_completion = false, .help_entry = "/paste", .completion_description = "attach an image from the clipboard when supported", .presentation_category = .media },
    .{ .kind = .fast, .command = "/fast", .help_entry = "/fast", .completion_description = "toggle Fast mode when supported", .presentation_category = .model },
    .{ .kind = .statusline, .command = "/statusline", .help_entry = "/statusline [context|session|workspace]", .completion_description = "toggle status line segments", .presentation_category = .appearance, .has_args = true, .accepts_payload = true },
    .{ .kind = .notifications, .command = "/sound", .help_entry = "/sound [on|off|max]", .completion_description = "toggle sounds and terminal bells", .presentation_category = .appearance, .has_args = true, .accepts_payload = true },
    .{ .kind = .workspace, .command = "/workspace", .help_entry = "/workspace [list|add PATH|remove PATH|clear]", .completion_description = "manage additional workspace directories", .presentation_category = .workspace, .show_in_welcome = true, .has_args = true, .accepts_payload = true },
    .{ .kind = .version, .command = "/version", .help_entry = "/version", .completion_description = "show the handwork version", .presentation_category = .general },
    .{ .kind = .quit, .command = "/quit", .aliases = &.{"/exit"}, .help_entry = "/quit", .completion_description = "exit the interactive shell", .presentation_category = .general, .show_in_welcome = true },
};

pub const slash_registry = SlashRegistry{ .commands = slash_specs[0..] };

pub fn matchesSlashExact(cmd: []const u8, kind: SlashKind) bool {
    return command_specs.matchesSlashExact(slash_registry, cmd, kind);
}

pub fn isExactSlashCommand(cmd: []const u8) bool {
    return slash_registry.matchExact(cmd) != null;
}

pub fn matchedSlashPrefix(cmd: []const u8, kind: SlashKind) ?[]const u8 {
    return command_specs.matchedSlashPrefix(slash_registry, cmd, kind);
}

pub fn renderSlashHelp(alloc: Allocator) ![]u8 {
    return command_specs.renderSlashHelp(alloc, slash_registry);
}

pub fn renderSlashWelcome(alloc: Allocator) ![]u8 {
    return command_specs.renderSlashWelcome(alloc, slash_registry);
}

pub fn firstSlashCompletion(prefix: []const u8) ?[]const u8 {
    return command_specs.firstSlashCompletion(slash_registry, prefix);
}

pub fn slashCompletionCount(prefix: []const u8) usize {
    return command_specs.slashCompletionCount(slash_registry, prefix);
}

pub fn nthSlashCompletion(prefix: []const u8, n: usize) ?[]const u8 {
    return command_specs.nthSlashCompletion(slash_registry, prefix, n);
}

pub fn nthSlashCompletionLabel(prefix: []const u8, n: usize) ?[]const u8 {
    return command_specs.nthSlashCompletionLabel(slash_registry, prefix, n);
}

pub fn nthSlashCompletionDescription(prefix: []const u8, n: usize) ?[]const u8 {
    return command_specs.nthSlashCompletionDescription(slash_registry, prefix, n);
}

pub fn nthSlashCompletionCategory(prefix: []const u8, n: usize) ?SlashPresentationCategory {
    return command_specs.nthSlashCompletionCategory(slash_registry, prefix, n);
}

pub fn slashCompletionHasArgs(command: []const u8) bool {
    return command_specs.slashCompletionHasArgs(slash_registry, command);
}

pub const argCompletionAnchor = command_specs.argCompletionAnchor;
pub const argCompletionIndexForLabel = command_specs.argCompletionIndexForLabel;
pub const allowlistArgCompletionPrefix = command_specs.allowlistArgCompletionPrefix;
pub const statuslineArgCompletionPrefix = command_specs.statuslineArgCompletionPrefix;
pub const notificationsArgCompletionPrefix = command_specs.notificationsArgCompletionPrefix;
pub const permissionsArgCompletionPrefix = command_specs.permissionsArgCompletionPrefix;

test "built-in slash commands register exact active order" {
    const expected_commands = [_][]const u8{
        "/help",
        "/clear",
        "/new",
        "/reset",
        "/resume",
        "/continue",
        "/rename",
        "/logout",
        "/provider",
        "/stats",
        "/usage",
        "/status",
        "/image",
        "/images",
        "/reasoning",
        "/model",
        "/permissions",
        "/allowlist",
        "/undo",
        "/mcp",
        "/skills",
        "/copy",
        "/feedback",
        "/trace",
        "/diff",
        "/jobs",
        "/export",
        "/doctor",
        "/context",
        "/compact",
        "/settings",
        "/alias",
        "/paste",
        "/fast",
        "/statusline",
        "/sound",
        "/workspace",
        "/version",
        "/quit",
    };

    try std.testing.expectEqual(expected_commands.len, slash_specs.len);
    for (expected_commands, slash_specs) |expected, spec| {
        try std.testing.expectEqualStrings(expected, spec.command);
    }
}

test "built-in slash registry resolves primary commands and aliases" {
    const login = slash_registry.lookup("/login") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.provider, login.kind);
    try std.testing.expectEqualStrings("/provider", login.command);
    const image = slash_registry.lookup("/img") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.image, image.kind);

    const usage = slash_registry.lookup("/usage") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.usage, usage.kind);

    const quit = slash_registry.matchExact("/exit\t") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.quit, quit.command.kind);
    try std.testing.expectEqualStrings("/exit", quit.token);

    const model = command_specs.matchedSlashPrefix(slash_registry, "/model\tmodel-id", .model) orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("/model", model);

    for ([_][]const u8{ "/setup", "/credits", "/balance", "/teams" }) |removed| {
        try std.testing.expect(slash_registry.lookup(removed) == null);
    }

    const model_command = slash_registry.lookup("/model") orelse return error.TestExpectedEqual;
    try std.testing.expect(!model_command.requires_prompt_credential);
    try std.testing.expect(slash_registry.lookup("/models") == null);

    try std.testing.expect(command_specs.matchedSlashPrefix(slash_registry, "/model\nmodel-id", .model) == null);
}

test "retired appearance slash commands are not registered" {
    try std.testing.expect(!isExactSlashCommand("/appearance"));
    try std.testing.expect(!isExactSlashCommand("/input"));
    try std.testing.expect(!isExactSlashCommand("/maxxing\t"));
    try std.testing.expect(!isExactSlashCommand("/input lines"));
    try std.testing.expect(!isExactSlashCommand("/unknown"));
}

test "built-in paste completion describes clipboard image attachment" {
    const completion = nthSlashCompletion("/pas", 0) orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("/paste", completion);

    const description = nthSlashCompletionDescription("/pas", 0) orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("attach an image from the clipboard when supported", description);
}

test "built-in slash utilities expose canonical names and reasoning alias" {
    try std.testing.expectEqualStrings("/reasoning", slash_registry.lookup("/effor").?.command);
    try std.testing.expectEqualStrings("/effor", nthSlashCompletion("/effor", 0).?);
    try std.testing.expectEqualStrings("/trace", slash_registry.lookup("/debug-trace").?.command);
    try std.testing.expectEqualStrings("/undo", slash_registry.lookup("/undo-file").?.command);
    for ([_][]const u8{ "/diff", "/jobs", "/export", "/doctor" }) |command| {
        const spec = slash_registry.lookup(command).?;
        try std.testing.expect(!spec.requires_prompt_credential);
        try std.testing.expect(spec.completion_description != null);
    }
}

test "built-in statusline help and completion include workspace" {
    const help = try renderSlashHelp(std.testing.allocator);
    defer std.testing.allocator.free(help);
    try std.testing.expect(
        std.mem.find(u8, help, "/statusline [context|session|workspace]") != null,
    );

    try std.testing.expectEqualStrings(
        "/statusline workspace",
        nthSlashCompletion("/statusline w", 0).?,
    );
}
