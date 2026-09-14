# handwork

Handwork is a coding agent for the terminal, written in Zig by [Connor Love](https://connorlove.com). You give it a task in a project directory. It can inspect files, search code, make edits, run commands and tests, and report what changed.

Handwork supplies the agent loop, terminal interface, tools, permissions, and saved conversations. A model provider supplies the model. You can use cloud APIs or an Ollama server, run one request from a script, or embed the agent in a JavaScript application.

The goal is a native coding agent that you can use across providers and reuse outside the terminal. The project puts the agent runtime and terminal code in Zig, with a separate JavaScript SDK for hosts that need their own interface, tools, or authentication. Fast startup and a responsive terminal are design goals, not claims that Handwork produces better code or runs faster than every alternative.

The npm CLI is currently version 0.0.9 and ships for macOS on Apple Silicon only. The repository also contains source builds, an SDK, and official Codex and Copilot runtime adapters. Those adapters run the provider's agent engine rather than Handwork's native agent loop.

## Contents

- [Quick start](#quick-start)
- [What it can do](#what-it-can-do)
- [How it compares](#how-it-compares)
- [Benchmarks](#benchmarks)
- [Future updates](#future-updates)
- [Providers and authentication](#providers-and-authentication)
- [Commands](#commands)
- [Permissions and data](#permissions-and-data)
- [Project context and extensions](#project-context-and-extensions)
- [Embedding and editor integration](#embedding-and-editor-integration)
- [Development and verification](#development-and-verification)
- [Current limits](#current-limits)

## Quick start

### Install the CLI

On an Apple Silicon Mac with npm installed:

```sh
npm install -g handwork
cd /path/to/your/project
handwork
```

Use `/provider` to choose a provider and enter its API key. The key-entry box masks typed and pasted text. Enter saves the key and connects; Esc cancels. Then use `/model` to choose a model and describe your task.

For example:

```text
Find the code that handles session recovery. Explain its failure cases before making changes.
```

For a coding task, ask for a specific change and the checks you expect:

```text
Fix the failing parser test. Keep the change focused, run the parser tests, and report the result.
```

Handwork can modify files and run programs. Inspect `/permissions` before your first task and review the changes afterward. The default mode is `auto`, which reviews unresolved permission requests. It is not a read-only mode.

### Run one request

Once a provider is configured:

```sh
handwork ask "Explain this project's entry points"
handwork ask --json "Review the current changes without editing files" > review.json
```

A request to avoid edits is an instruction to the model, not a replacement for permission controls.

### Build from source

Use Zig 0.16.0. From the repository root:

```sh
zig build
./zig-out/bin/handwork --help
./zig-out/bin/handwork
```

The native agent does not need the JavaScript runtime adapters to call model APIs. To use the official Codex or Copilot adapters from a source checkout, also install the npm dependencies:

```sh
npm ci
zig build
```

Those adapters require Node.js 22.12+ or 20.19+. The npm package's macOS arm64 restriction is not a promise of support for other source-build targets.

### Update

For a global npm installation:

```sh
handwork update
```

`update` is an alias for `upgrade`. It checks npm for a newer stable version and updates the whole package in the same installation prefix. Restart Handwork afterward. Use `handwork update --json` for machine-readable results. You can also run `npm install -g handwork@latest` directly.

Background automatic updates and the `dev` channel still require `HANDWORK_RELEASE_BASE_URL`, set to an HTTPS release service you operate. That service must supply the manifests, archives, and checksums the updater expects. When configured, manual updates use that service too. Without it, manual updates support global npm installations only; source builds must be rebuilt. npm packages are not silently updated in the background.

## What it can do

- Read files with line numbers, find paths by glob, search file contents, and make targeted edits.
- Run shell commands and tests. Long-running commands have managed sessions that the agent can observe, send input to, or stop.
- Stream model output in the terminal and accept image attachments where the selected model and transport support them.
- Save conversations, resume earlier work, recover supported damaged sessions, and compact long conversations into a shorter context.
- Delegate bounded tasks to subagents, including persistent named conversations for follow-up work.
- Apply permission rules to tool actions, ask for approval, or review unresolved actions in `auto` mode.
- Load project instructions and reusable skills. Connect local and remote tools through the Model Context Protocol, or MCP.
- Work with additional directories without changing the primary workspace.
- Draft pull requests and GitHub issues. Publishing is a separate `--create` option.
- Record local token usage and show provider-reported usage. Missing dollar costs remain unavailable rather than appearing as exact charges.
- Run through the Agent Client Protocol, or ACP, over stdio. Embed an agent or terminal through `libhandwork`.

These are runtime capabilities, not guarantees that a model will choose the right tool or produce a correct change. Check the diff and run the relevant tests.

## Model-led subagent orchestration

Describe preferences in your prompt or applicable `AGENTS.md`; there is no role router or server-side orchestration service. Direct user instructions override project preferences. For example (replace the placeholders with real model IDs available through your configured providers):

```text
Use <astra-model-id> through openrouter with high effort for planning.
Use <grok-model-id> through xai with auto effort for execution.
Keep both as named subagents. Pass the plan to the executor before editing.
I may send follow-ups to steer either role.
```

The parent chooses bounded tasks, hands results between roles, and integrates the work. The `subagent` tool accepts `provider`, `model`, and `effort` on `run` or the first `message` to a named child. Omitted values independently inherit the parent's settings. An explicit `provider` requires `model`; IDs remain opaque (including gateway namespaces), with no provider inference or alias guessing. Effort names are not hard-coded; `auto` omits explicit effort and uses the model default. The endpoint must support the chosen effort.

Named children accept follow-up messages while working: feedback queues for the next safe boundary without cancelling the current tool. Receipts are not completion. User follow-ups can redirect the parent and affected children; interrupting does not roll back completed actions. Provider/model/effort settings are creation-only and persist with the child. To change them, request a new named child with a handoff after conflicting work has stopped.

Cross-provider children use the selected provider's credentials, not the parent's API key. Configure credentials before delegation. A compatible gateway can use an existing API adapter's base URL, for example `HANDWORK_OPENAI_BASE_URL` with `provider: openai` and `OPENAI_API_KEY`. Compatibility means the gateway implements that adapter's authentication and API protocol (Chat Completions, or Anthropic Messages for `anthropic`); arbitrary gateway protocols and every model's reasoning controls are not guaranteed. There is no special `gateway` provider or hidden fallback to a different model.

This follows [fx's minimal delegation and named-conversation approach](https://fx.sh/docs/capabilities/subagents), extending it with explicit per-child model, provider, and effort selection.

## How it compares

Handwork, Codex CLI, Claude Code, and OpenCode all let a model inspect a repository, edit files, and run development tools. Skills, MCP connections, saved sessions, and permission controls are not unique to Handwork.

The useful differences are which engine runs the task, how you access models, and where you want to use the agent. This comparison describes documented integration choices, not a benchmark or an exhaustive feature matrix. The linked product documentation was checked on September 13, 2026.

| Tool | What you are choosing | How Handwork differs |
| --- | --- | --- |
| [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | OpenAI's terminal agent, with ChatGPT sign-in, local review, scripting through `codex exec`, and connections to Codex cloud workflows. | Handwork's native route uses its own tools and agent loop across several providers. `handwork runtime codex` instead uses the official Codex engine through App Server. Use Codex directly when you want its complete CLI and cloud workflow. |
| [Claude Code](https://code.claude.com/docs/en/overview) | Anthropic's coding agent across the terminal, IDE, desktop, and browser. It supports Claude subscriptions, Anthropic Console access, and documented third-party provider integrations. | Handwork's `anthropic` route uses a developer API key and Handwork's agent loop. It does not accept Claude.ai consumer subscription credentials or run the Claude Code engine. Use Claude Code when those official Claude workflows are the requirement. |
| [OpenCode](https://opencode.ai/docs/) | A multi-provider coding agent with terminal, desktop, and IDE clients. Its docs cover local customization, plugins, MCP, ACP, and an SDK. | Both projects offer provider choice and programmable use. Handwork's implementation centers on a Zig runtime and native terminal, plus a Node-API and WebAssembly SDK. Its current npm CLI distribution is narrower, at macOS arm64. |
| GitHub Copilot through Handwork | The official Copilot SDK and its agent engine, accessed with eligible Copilot credentials. | `handwork runtime copilot` is an adapter to that engine. It is not a Copilot model provider inside Handwork's native loop, and it does not bring every Copilot editor feature into Handwork. |

Choose Handwork when you want its terminal workflow, provider adapters, permission behavior, or embeddable runtime. Choose an official provider tool when you need that product's full subscription experience or product-specific integrations. Switching to Handwork does not transfer another tool's configuration, sessions, billing rules, or sandbox settings.

The [benchmarks below](#benchmarks) report task-specific comparisons and local performance checks. They do not establish a general ranking across projects or models.

## Benchmarks

### Recorded coding tasks

These are saved September 2026 pilot results, not new measurements of the current npm release. The recorded machine was an Apple M4 Pro with 24 GiB of memory and macOS 26.5.2. The clients used `gpt-6-astra`, low reasoning, and a configured 272,000-token context window through the existing ChatGPT subscription connection.

The pagination pilot used frozen Handwork 0.0.8, OpenCode 1.18.25, and the app-bundled Codex CLI 0.153.4. The authorization/cache series used an updated, separately frozen Handwork executable. Each report records the executable hashes and configuration. Do not read a comparison between those builds as a measurement of today's installed versions.

Each attempt started with a fresh workspace and session. Runs executed serially with rotated tool order. Complete success required the independent verifier and existing tests to pass, protected files to remain unchanged, and completion within the time budget.

| Task | Agent | Complete fixes | Median completion time | Median peak agent RSS |
| --- | --- | --- | --- | --- |
| Pagination, 300-second budget | Handwork, frozen baseline | 3/3 | 30.1 s | 34.5 MiB |
| Pagination, 300-second budget | OpenCode | 3/3 | 34.8 s | 762.5 MiB |
| Pagination, 300-second budget | Codex | 3/3 | 27.2 s | 229.8 MiB |
| Async search, original 300-second series | Handwork, frozen baseline | 5/5 | 58.7 s | 41.8 MiB |
| Async search, original 300-second series | OpenCode | 5/5 | 79.9 s | 757.2 MiB |
| Async search, original 300-second series | Codex | 5/5 | 32.9 s | 227.5 MiB |
| Authorization and cache isolation, 600-second budget | Handwork, updated build | 5/5 | 85.4 s | 31.1 MiB |
| Authorization and cache isolation, 600-second budget | OpenCode | 5/5 | 200.3 s | 811.3 MiB |
| Authorization and cache isolation, 600-second budget | Codex | 5/5 | 84.3 s | 214.0 MiB |

Handwork used less sampled agent memory in these runs. Codex had the lower median completion time on all three tasks. The authorization/cache timing difference between Handwork and Codex was about one second; five runs do not establish a meaningful speed advantage at that margin.

Read the [pagination method](benchmarks/fixed-budget/README.md) and [corrected results](benchmarks/fixed-budget/results/corrected/report-data.json), plus the [authorization/cache method](benchmarks/tenant-cache/README.md) and [results](benchmarks/tenant-cache/results/report-data.json). The pagination table uses only the corrected series. The earlier result that showed Handwork failing all three attempts came from a benchmark sandbox error and was withdrawn. Earlier attempts remain available for audit.

The async-search rows use the [original interleaved attempts](benchmarks/async-search/results/attempts.json), with five successful runs per agent and no timeouts or exclusions. See the [search method](benchmarks/async-search/README.md). Its later report replaces only Handwork's runs with the optimized runs below and retains the original competitor runs. That updated comparison is not a fresh interleaved three-agent series.

### Measured Handwork optimization

A separate search-race repair pilot compared five alternating pairs of frozen baseline and optimized Handwork builds. Both builds completed all five tasks within the 300-second budget and passed all nine independent check groups, the existing tests, and protected-file checks.

| Metric | Baseline | Optimized | Reduction |
| --- | --- | --- | --- |
| Median completion time, matched successes | 61.3 s | 48.6 s | 20.6% |
| Median peak agent RSS | 44.1 MiB | 27.8 MiB | 36.9% |
| Mean reported input tokens per attempt | 67,637.6 | 35,379.8 | 47.7% |
| Mean tool calls per attempt | 14.6 | 10.4 | 28.8% |

The changes combined related replacements into one atomic edit, grouped independent reads, limited read-only tool concurrency to two, and shortened repeated prompt text. These changes already exist in the tested revision. They are evidence for further work on tool and context efficiency, not future features being claimed early.

See the [optimization method](benchmarks/optimization/README.md) and [final paired results](benchmarks/optimization/results-final/report-data.json). The earlier [cross-tool search pilot](benchmarks/async-search/README.md) is a separate series; its results must not be mixed with the paired optimization runs.

### What the numbers include

Completion time includes client initialization, model inference, network delays, and tool execution. It is not a measurement of Zig execution speed alone. The hosted provider's service load and hardware placement were outside the benchmark's control.

RSS is sampled resident memory for the local agent process tree. The reports separate tests and other tool subprocesses. RSS can count shared mappings more than once, and polling can miss brief peaks. It excludes hosted model memory, so it is not total system memory or the cost of running a local model.

Reported token counts include client-visible usage under each report's accounting rules. They are not a billing audit. Native tool calls are not interchangeable units of work; one shell or code-mode call can perform several operations. The authorization/cache series used Handwork's `--no-save` mode, which did not provide a persistent subagent host in the frozen build.

These are project-maintained pilots with three or five attempts per agent on small TypeScript fixtures. They do not measure every language, repository size, workflow, or model. Claude Code was not measured, so this README makes no numerical comparison against it. The subscription route used for these historical tests does not resolve the native Codex authorization caveat in [subscription restrictions](#subscription-restrictions).

### Native performance checks

The source also includes deterministic component benchmarks. They require Zig 0.16.0, use synthetic workloads, and do not call a model or spend API credits.

```sh
zig build run-bench-file-index -Doptimize=ReleaseFast -- 100000 500
zig build run-bench-ui-activity -Doptimize=ReleaseSafe
zig build run-bench-approval-review -Doptimize=ReleaseSafe -- combined 100 1
```

| Check | Workload and result |
| --- | --- |
| [File search](benchmarks/file_index_bench.zig) | Searches 100,000 synthetic file and directory paths with eight query classes and 500 iterations per query. Reports build time and p50, p95, p99, and maximum search latency. Its current gate requires overall p95 below 16 ms. |
| [Activity updates](benchmarks/activity_progress.zig) | Compares lifecycle-driven progress updates with the raw transcript update path, then checks latency growth after 5,000 updates. Reports p95 ratios across repeated batches. This compares two internal paths, not two coding agents. |
| [Approval review](benchmarks/approval_review.zig) | The combined scenario exercises 50,000 transcript lines and a 50,000-line diff. Other scenarios cover transcript-only, diff-heavy, large-payload, and edge cases. |

The 16 ms file-search limit is a test threshold, not a result from a fresh run. Record the CPU, OS, Zig version, build mode, source revision, and full output when publishing results. Do not compare ReleaseFast and ReleaseSafe numbers as though they used the same build settings.

The [profile-guided build pipeline](scripts/pgso/README.md) also compares optimized candidates against a ReleaseSafe control. Its policy limits p50 and p95 regressions to 10% and caps the candidate binary at 7.800 MiB. These are qualification limits, not a claim that the current release meets them. The pipeline requires its pinned toolchain and complete behavior and performance checks before it marks a candidate eligible.

## Future updates

The aim is to make Handwork a better choice for users who care about low local memory use, short waits between tool actions, and a terminal that stays responsive during long tasks. The pilots support work in those areas. Beating other tools requires repeatable results on broader tasks, without lower correctness or weaker permission checks.

The following items are proposed development priorities, not shipped features or release-date commitments. Existing mechanisms provide a starting point; each update needs its own measurements.

| Priority | Planned work | How to judge the improvement |
| --- | --- | --- |
| Faster startup and reconnects | Defer optional discovery until needed. Reuse validated model and capability metadata with explicit invalidation. Keep offline commands independent of provider connections. | Measure cold and warm time to an editable prompt, command p50 and p95, network request count, and offline startup failures. |
| Fewer model round trips | Extend dependency-aware grouping of reads and edits. Remove repeated context while preserving instructions, errors, and verification evidence. Avoid redundant retries and checks. | Compare verified completion time, model requests, token usage, and repair success on matched tasks. Fewer calls only count as an improvement when the fix still passes. |
| Responsive large repositories | Improve incremental index refresh and cancellation of superseded searches. Keep result limits and match quality explicit. | Track picker p95, time to reflect file changes, and memory as repositories grow. Check ignored files, Unicode paths, and search correctness alongside latency. |
| Responsive long sessions | Reduce repeated transcript layout and diff preparation. Bound retained output and avoid repainting unchanged content. | Measure input-to-paint and approval-open p95 under long output streams, large diffs, terminal resize, and concurrent tool progress. |
| Smaller native releases | Extend profile-guided size and speed work without removing tools or weakening ReleaseSafe behavior. | Publish binary size and startup results beside heavy-workload p50 and p95. Require the full qualification checks rather than accepting size savings alone. |
| Clearer setup and provider controls | Make API billing versus subscription runtime selection explicit during setup. Explain missing model capabilities, credential precedence, and connection errors where users encounter them. | Measure time to a first successful task and count failed setup attempts. Test expired credentials, unavailable models, local Ollama, and offline recovery. |
| Safer interruption and recovery | Show which tools completed, which may have partially executed, and what a resumed session will do next. Connect and verify tracked-file undo before promising restoration. | Test interruption during reads, writes, and shell commands. Require recovery without duplicated side effects or misleading success messages. |
| Easier installation and integration | Qualify more platform packages, configure a release service, and document editor and SDK setup with tested examples. | Require install, update, rollback, and integration checks for each supported platform. Publish platform support only after those checks pass. |

### Evidence required for future claims

Expand the benchmark set to larger repositories, multi-file changes, long-running sessions, and multiple languages. Add Claude Code comparisons with supported authentication and clear model differences. Use the same model and reasoning settings where possible; otherwise report the comparison as a complete product workflow, not an isolated agent-runtime test.

Publish tool versions, executable hashes, prompts, run order, sample counts, verification rules, failures, and raw measurements. Compare success before speed, and include failed attempts in resource accounting. Report startup and terminal latency separately from hosted model latency.

Future release notes should identify the user-visible change, link its correctness checks, and show before-and-after measurements with any regressions. That is the standard for claiming an advantage over Codex, Claude Code, or OpenCode.

## Providers and authentication

There are two execution paths. Keep them separate when choosing credentials or diagnosing permissions.

| Path | Commands | Who runs the agent and owns its tools |
| --- | --- | --- |
| Native Handwork | `handwork`, `handwork ask`, `/provider` | Handwork uses the selected model transport and its own permission and session systems. |
| Official runtime | `handwork runtime codex ...`, `handwork runtime copilot ...` | The provider's engine owns tools, saved sessions, configuration, sandbox behavior, and billing. |

### Native API providers

Use `/provider` in the terminal to save a key without shell configuration. `/login` is an alias. For automation, you can supply an environment key:

```sh
export OPENAI_API_KEY="your-api-key"
handwork login openai
handwork ask "Explain the build configuration"
```

Replace the placeholder with your own key. Do not commit credentials or put them in shared scripts.

| Provider ID | Optional environment key | Billing route |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | OpenAI API |
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic API |
| `gemini` | `GEMINI_API_KEY` | Gemini developer API |
| `xai` | `XAI_API_KEY` | xAI developer API |
| `deepseek` | `DEEPSEEK_API_KEY` | DeepSeek API |
| `mistral` | `MISTRAL_API_KEY` | Mistral API |
| `groq` | `GROQ_API_KEY` | Groq API |
| `together` | `TOGETHER_API_KEY` | Together AI API |
| `fireworks` | `FIREWORKS_API_KEY` | Fireworks AI API |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter API |
| `minimax` | `MINIMAX_SUBSCRIPTION_KEY` | MiniMax Token Plan |
| `ollama` | None | Your Ollama server |
| `ollama_cloud` | `OLLAMA_API_KEY` | Ollama cloud plan |

Saved keys take precedence over environment keys. Handwork stores keys in provider-specific `~/.handwork/api-key-*` files with owner-only mode `0600`, separate from settings and conversation history. These files are not encrypted at rest.

`handwork logout <provider>` or `/logout <provider>` removes the saved key. If you also set an environment key, unset it separately.

For the API providers, set `HANDWORK_<ID>_MODEL` or `HANDWORK_<ID>_BASE_URL` to override the model or endpoint. Use the provider ID in uppercase. For example, `HANDWORK_OPENAI_MODEL` selects an explicit OpenAI model.

A base URL includes the API version prefix, but not `/chat/completions`, `/messages`, or `/models`. Custom endpoints require HTTPS. Loopback HTTP requires an explicit port. Handwork sends the key to that endpoint, so use only an endpoint you trust.

Most providers discover models through their official API. An explicit model override supplies a one-model catalog for private models or services without model discovery. MiniMax has a default model. Available models and account entitlements depend on the provider.

Native API adapters support text streaming, tool calls, and token counts. Capability support varies. The public API adapters do not currently advertise reasoning-effort controls or provider-specific caching. Vision request serialization exists, but model discovery uses conservative vision metadata. Anthropic structured-output requests return an explicit unsupported error.

### Ollama local and cloud

For local models, start Ollama and pull a model that supports tool calls:

```sh
ollama serve
```

If Ollama is already running, do not start another server. In another terminal:

```sh
ollama pull <model>
handwork login ollama
handwork
```

Replace `<model>` with the model you want to run. Handwork does not start Ollama or download models for you.

The local route discovers models at `http://localhost:11434/v1/models`. It sends no API key, even when `OLLAMA_API_KEY` is set. `HANDWORK_OLLAMA_BASE_URL` and `HANDWORK_OLLAMA_MODEL` override the endpoint and model. Include `/v1` in the base URL.

A signed-in Ollama server can also route cloud models to your Ollama account. For local-only inference, use a locally installed model and disable Ollama's cloud features. Choosing `ollama` alone does not guarantee that inference stays on your machine.

For direct cloud access, create a key at [Ollama account keys](https://ollama.com/settings/keys), choose Ollama Cloud in `/provider`, and paste it. You can also use:

```sh
export OLLAMA_API_KEY="your-ollama-key"
handwork login ollama_cloud
handwork
```

The direct cloud route uses `https://ollama.com/v1`. `HANDWORK_OLLAMA_CLOUD_BASE_URL` and `HANDWORK_OLLAMA_CLOUD_MODEL` supply overrides. Your plan limits still apply. Handwork does not fall back between local and cloud providers.

See [Ollama cloud access](https://docs.ollama.com/cloud) and [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).

### Official Codex runtime

Install the official Codex CLI and put `codex` on `PATH`, then run:

```sh
handwork runtime codex login
handwork runtime codex models
handwork runtime codex ask "Review this repository"
handwork runtime codex ask
```

The adapter uses [Codex App Server](https://learn.chatgpt.com/docs/app-server). Login prints the official browser URL. This subscription route requires a ChatGPT account and rejects API-key authentication. Set `HANDWORK_CODEX_PATH` to select another installed Codex executable.

### Official Copilot runtime

The npm dependencies include a pinned official Copilot SDK. Authenticate through the official Copilot CLI first:

```sh
copilot login
handwork runtime copilot login
handwork runtime copilot models
handwork runtime copilot ask "Review this repository"
```

Handwork's `login` command checks the runtime's existing login. Handwork does not collect GitHub credentials. `COPILOT_CLI_PATH` can select an existing official CLI installation. See the [Copilot SDK](https://github.com/github/copilot-sdk) for account and runtime requirements.

Both runtime adapters accept `--model ID` and `--resume ID`. Omitting the prompt starts an interactive conversation. `/exit` leaves it, and Ctrl-C interrupts the turn and shuts down the adapter.

Runtime permission requests require an affirmative terminal answer. Noninteractive permission requests are denied. Handwork's native `/permissions`, workspace rules, and saved sessions do not configure these engines.

### Subscription restrictions

Native Codex access also exists through `/provider codex` and `handwork login codex`, including saved credentials. That direct OAuth and backend integration has unverified authorization under provider terms. It is separate from the documented App Server route. Prefer `handwork runtime codex` when you need the documented integration path.

Native Grok subscription access remains disabled. Use `xai` with a developer API key. Qwen Token Plan is disabled because its interactive-only restrictions are not enforced across Handwork's backend and automation entry points. Handwork includes no Claude or Gemini consumer subscription-token integration. Kimi Code and Z.AI subscriptions remain excluded.

Subscription keys do not fall back to a pay-as-you-go key. MiniMax can still charge purchased credits for quota overflow on its own side. Handwork cannot prevent that provider-side billing behavior.

The [provider integration audit](docs/provider-terms-audit.md) records sources, implementation limits, and account and deployment obligations. A supported route is not a blanket certification of compliance with provider terms.

## Commands

Run `handwork --help` for the command list and `handwork <command> --help` for exact options.

### Shell commands

| Command | Purpose |
| --- | --- |
| `handwork` | Start a fresh interactive session in the current directory. |
| `handwork ask <prompt>` | Run one native agent request and exit. A prompt can also arrive on stdin when no prompt arguments are present. |
| `handwork pr [context]` | Draft a pull request inside a Git repository. Add `--create` to publish through the GitHub CLI. |
| `handwork issue [context]` | Draft a GitHub issue. Add `--create` to publish. |
| `handwork sessions` | List saved sessions for the current workspace. |
| `handwork session <last\|id>` | Inspect a saved session. Add `--json` for machine-readable output. |
| `handwork session resume [last\|id]` | Resume the latest workspace session or a specific session. |
| `handwork session migrate <id>` | Migrate a saved session to the current format. |
| `handwork session recover <id>` | Copy a recoverable corrupt session into a new session. |
| `handwork login [provider]` | Authenticate with a native provider. |
| `handwork logout [provider]` | Remove the provider's saved credentials. |
| `handwork provider <provider>` | Select the active native provider. |
| `handwork models` | List available models. |
| `handwork runtime <codex\|copilot> <login\|models\|ask>` | Use an official provider agent runtime. |
| `handwork usage --period 7d` | Show locally recorded usage. Periods are `24h`, `7d`, and `30d`. |
| `handwork status` | Show configuration and runtime information. Supports `--json`. |
| `handwork doctor` | Run local health and preflight checks. |
| `handwork permissions` | Show native permission mode and rules. Supports `--json`. |
| `handwork workspace [list\|add PATH\|remove PATH\|clear]` | Manage saved additional directories for the current primary workspace. |
| `handwork mcp <command>` | Manage MCP configuration, authentication, and project trust. |
| `handwork upgrade` | Use the configured release service to update Handwork. |
| `handwork acp` | Start an ACP server over stdio. |
| `handwork --version` | Print the CLI version. |

GitHub publishing needs the GitHub CLI and appropriate authentication and repository access. Drafting alone does not publish anything.

### Launch and automation options

| Option | Behavior |
| --- | --- |
| `-c`, `--continue` | Resume the remembered workspace session. |
| `-r` | Open the saved-session picker. |
| `--resume [last\|id]` | Resume the latest session or an exact ID. |
| `--add-dir PATH` | Add a directory for this launch. Repeat for several directories. |
| `--no-additional-dirs` | Ignore saved additional directories. |
| `--context-limit name=bytes` | Override a context budget. Repeat for separate budgets, or use `name=off`. |
| `ask --json` | Emit a machine-readable result. |
| `ask --quiet` | Suppress assistant output. |
| `ask --no-save` | Do not save the session. Cannot combine with resume options. |
| `ask --image PATH` | Attach an image. Repeat for multiple images. |
| `ask --system TEXT` | Replace the built-in base prompt for the request. Tool, skill, project, and runtime context still apply. |
| `ask --auto` | Review unresolved permission requests automatically. |
| `ask --prompt-permissions` | Allow terminal permission prompts when stdin is a TTY. |
| `ask --full-access` | Disable Handwork permission checks. `--yolo` is an alias. |
| `ask --resume <last\|id>` | Continue a saved session without opening the interactive interface. |
| `ask --continue-recovery` | Resume a paused model response in the selected session. |
| `ask --no-color` | Disable colors and hyperlinks in TTY output. |
| `ask --` | Treat the remaining arguments as prompt text. |

For redirected `ask` output, stdout contains assistant Markdown and stderr contains progress and diagnostics. With `--json`, `output` contains accumulated assistant Markdown. `final_output` contains only the completed final response, or an empty string if none exists.

JSON usage sums reported main-agent input and output tokens. Missing counts are `null`; nested-agent usage and dollar spend are not part of that total. Do not treat it as your provider's invoice.

### Interactive commands

These commands belong to the native terminal interface, not the official runtime adapters.

| Commands | Purpose |
| --- | --- |
| `/help` | Show available slash commands. |
| `/provider`, `/login`, `/logout [provider]` | Connect, switch, or sign out of a provider. |
| `/model <id-or-query>` | Choose a model and its supported reasoning effort. |
| `/reasoning [effort]` | Change reasoning effort without changing the model or fast-mode setting. |
| `/fast` | Toggle fast mode where supported. |
| `/new`, `/resume`, `/rename <title>` | Start, reopen, or name a session. |
| `/clear` | Start a fresh conversation while keeping managed processes. |
| `/reset` | Reset the current session context. |
| `/continue` | Continue a paused model response. |
| `/compact` | Summarize the conversation into a fresh context window. |
| `/undo` | Registered for tracked-file undo; file restoration is not verified in this revision. |
| `/copy` | Copy the last assistant response. |
| `/permissions [ask\|auto\|full-access\|reset]` | Inspect or change the permission mode. |
| `/allowlist` | Manage trusted commands, tools, and URLs at local or user scope. |
| `/workspace [list\|add PATH\|remove PATH\|clear]` | Manage additional workspace directories. |
| `/mcp` | Manage servers, resources, prompts, authentication, and project trust. |
| `/skills` | Browse, install, inspect, create, or remove skills. `$` opens skill search. |
| `/image <path>`, `/img <path>`, `/paste` | Attach an image by path or supported clipboard access. |
| `/images [clear]` | Inspect or clear pending image attachments. |
| `/stats` | Show token and turn statistics. |
| `/usage`, `/cost` | Show locally recorded tokens, models, and spend. |
| `/status`, `/version` | Inspect runtime configuration or version. |
| `/settings` | Browse and update settings. |
| `/statusline [context\|session\|workspace]` | Toggle status-line segments. |
| `/sound [on\|off\|max]` | Configure sounds and terminal bells. |
| `/trace` | Copy a private diagnostic trace. Review it before sharing. |
| `/feedback` | Open the feedback form. |
| `/quit`, `/exit` | Exit the interactive shell. |

`/alias` currently reports alias availability; do not assume custom aliases are implemented. Model reasoning, fast mode, clipboard access, and images depend on the active model and host.

Clipboard photos: in the composer, Ctrl+V attaches an image from the local macOS clipboard. Cmd+V works when the terminal forwards it as a Super+V keyboard report; terminals commonly intercept Cmd+V for their own text paste instead. A terminal text paste does not transmit image bytes, and Handwork does not inspect the image clipboard during bracketed text paste. The macOS clipboard must offer PNG data. Clipboard access is on the machine running Handwork, not your local desktop when using SSH. If the terminal consumes the shortcut, or the host/clipboard format is unsupported, save the photo and use `/image <path>`.

Click and drag in the composer to highlight text; releasing the mouse copies the selected text without deleting it. A plain click only moves the caret. Drag selection supports either direction and multiple visible input lines.

Hover-to-copy: move the pointer over composer text to copy the current selection, or the whole draft if nothing is selected. Moving within the text does not repeatedly replace the clipboard; leaving and re-entering or changing the text enables another copy. Modified hover does not copy. This requires terminal SGR mouse-motion support. Hold Shift for native terminal selection/scrolling where supported. Terminal-owned selections are not visible to Handwork.

## Permissions and data

Handwork's native permission modes are:

| Mode | Behavior |
| --- | --- |
| `ask` | Prompt before sensitive tool calls that lack authorization. |
| `auto` | Apply rules and existing authorization, then review unresolved sensitive actions. This is the default. |
| `full-access` | Disable Handwork permission checks. |

In `auto` mode, a clear review authorizes the specific action. A caution or unavailable review holds that action rather than opening an approval prompt. `auto` does not mean every command is approved.

Use `/allowlist` for persistent trust rules and `/permissions ask` when you want explicit prompts. Inspect the effective configuration with `handwork permissions --json`.

Permission checks do not make generated code correct, and they are not a substitute for operating-system isolation. `full-access` removes Handwork's checks; use it only when you accept that the agent can act with the process's access.

Native sessions live under `~/.handwork/sessions`, with a `session.json` file for each session. Prompt history is separate at `~/.handwork/history.jsonl`. Official runtime sessions belong to the provider runtime, not the native session store.

Resuming a session restores conversation state, not a snapshot of your files or running programs. An interrupted tool may have partially executed. Inspect the workspace before continuing an interrupted task.

Cloud requests can contain your prompt, repository excerpts, tool results, and conversation context. That data leaves your machine for the selected endpoint. Review provider retention and training terms before sending private code. Session files, SDK checkpoints, and diagnostic traces can also contain sensitive material.

Do not rely on `/undo` to restore your work. The command is registered and a tracked-file undo implementation exists, but this source review did not verify a production connection between them. Neither is a rollback for arbitrary shell commands or remote changes. Use Git checkpoints and backups for work you need to restore.

## Project context and extensions

Handwork can load project guidance, skills, and MCP capabilities into a native session. These extend what the agent knows or can call; they do not replace permission checks.

### Settings and project instructions

| Path | Purpose |
| --- | --- |
| `~/.handwork/settings.json` | User settings and workspace-specific user overrides. |
| `<workspace>/.handwork.json` | Supported project settings. |
| `~/.handwork/AGENTS.md` | Personal instructions for native sessions. |
| `<workspace>/AGENTS.md` | Project instructions. |
| `~/.handwork/mcp.json` | User MCP configuration. |
| `<workspace>/.mcp.json` | Project MCP configuration, subject to trust approval. |
| `~/.handwork/skills/` | Managed skill installations. |

The settings loader applies project settings, then user settings, then workspace-specific user overrides. Project files cannot set permission mode, permission rules, credentials, additional directories, or model and provider preferences. Handwork reports ignored project settings for these user-only options. Use `/settings`, `/permissions`, and `/workspace` instead of putting them in a project file.

Put build commands, coding conventions, and project-specific instructions in `AGENTS.md`. Handwork also considers applicable launch ancestors and scoped instruction files selected for structured file targets. It does not recursively include every `AGENTS.md`. Selection and file-size limits bound the loaded context, and Handwork records omissions.

### Additional directories

For one launch:

```sh
handwork --add-dir ../shared-library
```

To save an additional directory for the current workspace:

```sh
handwork workspace add ../shared-library
handwork workspace list
```

Use `--no-additional-dirs` to ignore saved additions for a launch. Adding a directory does not switch the primary workspace.

### Skills

Skills package reusable instructions in `SKILL.md` files. Use `/skills list` to inspect installed skills and `/skills path` to find their storage. `/skills show <name>` displays a skill, and `/skills install <url-or-path>` installs one. Read skills from unfamiliar sources before allowing their instructions to guide work.

Discovery includes project and ancestor skill directories, managed installations, and compatibility directories for other coding tools. Finding a skill does not automatically load its instructions. Invoke the skill explicitly or have the agent load it through the skill tool.

### MCP

MCP connects the agent to tools and data supplied by another process or service. Handwork supports stdio, HTTP, and SSE transports, plus resources, prompts, and argument completion when the server implements them. Pending or rejected project servers do not connect.

```sh
handwork mcp add my-server /absolute/path/to/server --server-option
handwork mcp add --transport http remote-server https://mcp.example.com/mcp
handwork mcp list
handwork mcp list --connect
handwork mcp auth remote-server
handwork mcp path
```

Replace the server command and example URL with your actual service. A configured local server can execute code when Handwork connects to it. A remote server can receive data sent to its tools.

`mcp list` reads configuration without opening transports. Add `--connect` to discover servers and inspect connection health. Use `mcp trust approve NAME` or `mcp trust reject NAME` for project server trust. The interactive `/mcp` command also exposes resources and prompts.

### Subagents

The agent can delegate a one-off task or send work to a persistent named agent. New children inherit the parent's model and reasoning effort unless creation specifies an override. Existing children do not accept those creation-time overrides.

Children inherit the parent's tool and integration restrictions, permission rules, grants, and MCP access. They cannot raise their permission level above the parent's. Delegation does not grant independent authority to perform otherwise blocked actions.

## Embedding and editor integration

The [JavaScript SDK](sdk/README.md) is `libhandwork`. It exports `createHandworkAgent` and `createHandworkTerminal`.

- `createHandworkAgent` creates an in-memory conversation with `prompt`, `checkpoint`, and `close` operations. Prompts stream events, and the host can provide tools and instructions.
- `createHandworkTerminal` embeds the terminal interface in a host application.
- Node.js uses a native Node-API addon when available and can fall back to WebAssembly. Browsers use WebAssembly with JSPI support.
- The host owns authentication through its `fetch` adapter, durable checkpoint storage, and the effects of JavaScript tools.

The embedded agent does not include the CLI's built-in shell and filesystem tools. The host supplies tools and controls their effects. Only one prompt runs at a time. Consume its event stream before awaiting the final result; an unread stream can block completion.

Checkpoints contain conversation history and usage only. The agent must be idle when you take a checkpoint. The host must store checkpoint bytes and resupply configuration, credentials, instructions, tools, MCP clients, and skills when restoring an agent.

The SDK is not the CLI with every native provider automatically available. Its default model discovery is Codex-specific. The WASM provider menu retains a host-managed Codex route; native API-key transports are not advertised there. Embedded terminal hosts can use `HANDWORK_AUTH_MODE=host-managed` and supply their own transport authentication.

See the SDK README for backend builds, streaming, cancellation, checkpoints, and host-owned MCP and skills adapters. Embedding does not grant permission to reuse consumer subscription tokens.

For an editor or other client that speaks ACP:

```sh
handwork acp
handwork acp --model <model-id> --log-file /path/to/handwork-acp.log
```

ACP uses stdio for protocol messages. This is an integration endpoint, not a bundled editor extension.

## Development and verification

### Repository layout

| Path | Contents |
| --- | --- |
| `src/main.zig` | Native executable entry point. |
| `src/core/` | Agent runtime, application state, CLI, sessions, permissions, and terminal support. |
| `src/builtins/` | Built-in commands, tools, providers, skills, and context setup. |
| `src/provider/` | Model-provider code. |
| `src/acp/` | ACP server and protocol handling. |
| `runtime/` | JavaScript adapters for official Codex and Copilot engines. |
| `sdk/` | JavaScript SDK, native and WebAssembly bindings, and SDK tests. |
| `tests/e2e/` | CLI, terminal, protocol, and provider integration tests. |
| `tests/evals/` | Agent evaluations and shared evaluation helpers. |
| `benchmarks/` | Native component benchmarks, coding-task pilots, and saved measurement evidence. |
| `scripts/` | Build, packaging, signing, and optimization utilities. |
| `docs/provider-terms-audit.md` | Provider integration evidence and restrictions. |

### Checks

Run the Zig tests:

```sh
zig build test
```

Use `-Dtest-filter` for a focused Zig test run. The CLI tests use Bun; the official runtime tests use Node.js:

```sh
zig build test -Dtest-filter="public API"
bun test tests/e2e/cli.test.ts -t 'help (renders|documents)'
python3 tests/e2e/api-providers.py
python3 tests/e2e/api-key-entry.py
node --test runtime/runtime.test.mjs
```

The provider checks above use synthetic keys, isolated profiles, and local mock services. They do not spend credits or validate live account entitlements. Other terminal tests can require tmux, and some evaluations require a configured live provider. Read the relevant test before running a broad suite.

## Current limits

- The published npm CLI targets macOS arm64. Do not assume an equivalent supported installation on Linux, Windows, or Intel Macs.
- Official Codex and Copilot adapters are separate engines. Native Handwork permissions, sessions, and provider controls do not carry over.
- Native and embedded provider support differ. Model-specific controls are not available on every transport.
- Token and spend reports are local records, not authoritative billing totals.
- Built-in updates require a configured release service.
- Provider terms, model access, quotas, and organization policies still apply. The direct native Codex route has unverified authorization.

For feedback, run `/feedback` or visit [connorlove.com](https://connorlove.com).
