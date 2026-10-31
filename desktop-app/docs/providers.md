# Provider setup

In this Handwork port, Handwork is bundled and selected by default. It uses `~/.handwork` credentials and `handwork login <provider>`. The direct CLI integrations described below remain available.

Install and sign in to at least one supported agent before using Handwork. Handwork runs the CLIs you install and reuses their existing logins.

Follow each provider’s linked installation guide for platform requirements and installation options. Use the installation and login commands below where provided.

- [Claude Code](https://claude.com/product/claude-code) - `claude auth login`
- [Codex](https://developers.openai.com/codex/cli) - `codex login`
- [Cursor CLI](https://cursor.com/cli) - `agent login`
- [Grok Build](https://docs.x.ai/build/overview) - `curl -fsSL https://x.ai/cli/install.sh | bash` then `grok login`
- [OpenCode](https://opencode.ai) - `opencode auth login`
- [Antigravity](https://antigravity.google/docs/cli-install) (macOS/Linux) - `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in
- [Pi](https://pi.dev/) - `npm install -g @earendil-works/pi-coding-agent`
- [omp](https://omp.sh) - `curl -fsSL https://omp.sh/install | sh`
- [fx](https://fx.sh) - `curl -fsSL https://fx.sh/setup.sh | bash` then `fx login`
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) - macOS/Linux: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`; Windows PowerShell: `iex (irm https://hermes-agent.nousresearch.com/install.ps1)`; then run `hermes model`
- [Devin CLI](https://docs.devin.ai/cli) - macOS/Linux: `curl -fsSL https://cli.devin.ai/install.sh | bash` (or `brew install --cask devin-cli`); Windows PowerShell: `irm https://static.devin.ai/cli/setup.ps1 | iex`; then run `devin auth login` (Handwork reuses that login)

One provider is enough. Handwork probes for each CLI at startup and disables the ones it can’t find, with a hint about how to install them, so a missing Codex doesn’t stop you from working on anything else.

Once a provider is installed and signed in, open a project folder in Handwork, choose that agent, and send a message. For sessions on another machine, install and authenticate the providers on the host as described in [remote access](remote-access.md).

To run Handwork from a checkout, see [building from source](building.md). Return to the [README](../README.md) for desktop downloads.

## Claude Code in the Electron desktop app

Claude Code appears separately from the Anthropic API connection. Install the
`claude` CLI and run `claude auth login` in a terminal, then select **Claude Code**
from a new chat's provider menu. Settings → Models also lets you select it as the
default for new chats. Handwork uses the official Claude Agent SDK with that CLI
and its existing login; it does not copy Claude credentials into Handwork.

Model choices, versioned display names, descriptions, and resolved model IDs come
from the installed CLI through the SDK’s `supportedModels()` method. Discovery
sends no model prompt. The generic Default alias is hidden; new chats select the concrete model it
resolves to, and saved Default selections migrate to that model.
Supported effort levels and an opt-in fast-mode switch appear only when reported
by the selected model; changing models clears incompatible settings. A reported
model is not a guarantee of account entitlement or remaining quota. Code mode uses Claude's normal permission checks
and displays tool approval requests in Handwork; Ask mode uses Claude's plan mode.
Claude reads its own user and project settings and CLAUDE.md instructions.
Handwork's native-engine tool settings do not configure Claude Code.

Replies, tool activity, cancellation, image attachments, saved history, and chat
search are supported. Desktop transcripts are saved as `claude.json` beside the
native session files, so desktop backups include them. Resuming also requires the
original Claude session stored by Claude Code on this machine; a backup of
Handwork alone does not transfer Claude's session store or login. Switching an
existing conversation between the native engine and Claude requires a new chat.
Editing earlier messages to create a branch is not yet supported for Claude chats.


### Anthropic terms review (October 28, 2026)

Handwork runs the user's installed, unmodified Claude Code through Anthropic's
published Agent SDK. Authentication stays in the CLI's own flow. Handwork does
not read credential files or the Keychain, implement OAuth, proxy inference,
spoof a first-party client, resell usage, or bypass limits. Each user supplies
their own authentication and is billed directly. All CLI authentication methods
remain available. The integration identifies the provider with the Claude logo and a descriptive
provider label, as requested by the product owner; this is not a claim of
Anthropic endorsement. Trademark permission remains the distributor's responsibility.

Anthropic's [Claude Code legal guidance](https://code.claude.com/docs/en/legal-and-compliance)
permits running the unmodified binary in another product subject to its conditions
and the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms).
It distinguishes users signing into that binary themselves from developers
collecting tokens or offering their own Claude.ai login. Product developers must
establish that the applicable agreement covers their deployment before distribution;
this implementation review is not legal certification or Anthropic approval.

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk) recommends API
keys for third-party products and restricts offering Claude.ai login or rate limits
without approval. Do not advertise Handwork as providing subscription capacity.
The [current billing notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says SDK usage with a user's Claude plan still draws from that plan's limits;
API-key billing is separate. Billing availability does not replace the product
conditions above. Recheck these sources before release or changes to hosting,
authentication, or billing.


Signed-in Codex and Claude Code accounts appear together in the sidebar footer.
Claude usage percentages and scheduled resets come only from SDK
`rate_limit_event` reports emitted during chats. The last reading is kept in
memory, cleared when the detected account changes, and labeled with its report
time. After restarting Handwork it waits for a new report. Refreshing does not
send a model prompt or query a private OAuth endpoint. Missing values remain
unknown, and an elapsed reset does not imply restored allowance. Codex alone
currently supports banked reset credits and redemption in Handwork.
