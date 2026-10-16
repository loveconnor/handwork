# Handwork Desktop

This checkout contains the desktop app at the repository root. Run desktop commands here. The native engine lives in the sibling `handwork/` checkout. Signed releases are built from the synchronized `desktop-app/` folder in [loveconnor/handwork](https://github.com/loveconnor/handwork).

New chat opens a standalone conversation with messages and attachments. Start a
project chat from the project's menu. Standalone chats use a private directory,
exclude project instructions and coding tools, and retain their own attachments.
Native web search is available with the Codex provider; other current adapters
can read known URLs but do not advertise search. Search sources appear as links
in the response. No separate search account or key is required.

Attachments accept any file extension through the file picker or drag and drop.
Supported PNG, JPEG, GIF, and WebP images are sent as images; UTF-8 picker files
are inlined as text. Other files retain their original bytes in private local
copies under the desktop profile's `attachments` directory (or the standalone
chat's private `attachments` directory), and the native agent
receives a file target to inspect with suitable local tools. Attaching a format
does not guarantee that every model or local tool can interpret its contents.
The existing limits remain 5 MB per file, 10 attachments, and 7 MB total encoded
attachment data per message. File-only messages are supported. Local copies are
retained so saved chats can continue referencing them.

Provider choices update immediately while their model catalog syncs in the
background. Previously visited providers reuse their displayed model choices.
Engine configuration requests stay ordered; sending waits for the latest choice
to activate. Failed changes restore the last confirmed settings and retain the
draft. The first activation may still require the provider's catalog request.

The `/harness` route and Electron app use Honest UI 0.2.3 and Honest AI:
SidebarNav, PromptBar, ChatThread, ChatMessage, Markdown with Honest Prose and
Prose Syntax, ThinkingState, ToolChips, ApprovalCard, TaskRows, and LoadingState.
Controls and settings use copied Honest UI components, with their retained MIT
license in `components/ui/LICENSE`. The older gallery remains reference material;
it is not imported by the desktop renderer.

The local Honest AI `components/ui/prompt-bar.tsx` adds slots for native attachment
previews and a leading toolbar action. It retains slash-command suggestions,
keyboard submission, IME handling, and Stop behavior. Draft height also updates
when the window width changes, up to the component's 160px scrolling limit.

Provider marks use Honest UI's logo assets. Additional marks use local
SVG paths from the installed Simple Icons CC0 catalog (its asset metadata records
their upstream sources); brand marks remain subject to their owners' trademarks.
Model task profiles live in `lib/model-presentation.ts`, with review date and
provider documentation. Only reviewed exact model IDs receive profiles; unknown
models keep their supplied descriptions. Model rows use text without category icons. Profiles describe intended work, not rankings,
benchmarks, live pricing, or subscription charges.

Project folder rows expand and collapse their chats. Chat selection updates
immediately; the renderer keeps the 20 most recently visited conversations in
memory for instant previews while the native engine activates the selected chat.
First-time visits show the chat title and a loading state until history arrives.
Rapid selections keep the latest requested chat visible; submitting stays blocked
until its native session is ready. During a response, other chats can be previewed
without interrupting the running agent; native activation waits for it to finish.

Desktop sessions actively generate GenUI. The native engine receives the
build-generated component catalog through
`initialize.clientCapabilities.handwork.responseInstructions`, outside saved
user messages. Responses stay in Markdown, with fenced `honestai` programs for
useful tables, charts, forms, and choices. `scripts/build-genui-prompt.mjs` and
`lib/genui-library.ts` share the allowlist in `electron/genui-components.mjs`.
Rebuild both the sibling engine and desktop after changing this integration.

Generated views cannot call renderer tools, run scripts, load model-selected
media, or open URLs. An explicit `@ToAssistant` interaction sends a follow-up
message (including its context and submitted form values) through the ordinary
Handwork prompt path; native permissions still govern tool execution. Invalid
programs show an error and their source. Form values are kept in memory while a
view is mounted; unsent changes are not durable across reloads. GenUI generation
quality depends on the configured model; no extra model provider is used.

Saved replies that start with a bare `root = Stack(...)` program also render as
GenUI without changing the stored reply. Maps use HonestAI's geocoding gateway
at `ai.honestui.com` (Nominatim), OpenFreeMap tiles, and USGS satellite imagery.
Place names are sent for lookup; tile providers receive map-area requests.
The desktop gateway accepts bounded place queries, caches results in memory
for up to a day, and exposes no arbitrary fetch API. Failed lookups or unavailable
maps keep the place list visible. Build and development commands copy the
installed MapLibre worker and shared module into the served assets.

## Run the desktop app

Development requires Node.js 24+ and macOS Apple Silicon or Windows x64/ARM64.
Keep the native `handwork` source checkout beside this `handwork-desktop` folder.
Build its engine with Zig 0.16 (`cd ../handwork && zig build`), then:

```sh
npm install
npm run desktop:dev
```

Connect a provider through the app's settings, or use `handwork login <provider>`
with an existing CLI installation. Development uses the
sibling `../handwork/zig-out/bin/handwork` binary (`handwork.exe` on Windows); `HANDWORK_BINARY` can explicitly
select a trusted alternative. On macOS, the development launcher caches a locally
signed `Handwork.app` under `node_modules/.cache/handwork-desktop` so the Dock and
application switcher display Handwork. The installed Electron runtime is preserved.
Credentials stay with the native engine, outside
the renderer. The app initializes a standalone chat on launch; sending a prompt
can incur provider charges. Project chats also expose tools that can change files.

```sh
npm run typecheck
npm run desktop:build
npm run desktop:package
```

The Changes panel follows the selected project's Git working tree, including
staged, unstaged, and untracked files changed outside the chat. It refreshes
automatically while the app is visible and has a manual Refresh control. File
previews are read-only; binary files and preview size limits are identified in
the panel. Folders without Git show an explicit unavailable state.

Frontend and website packages are build-time dependencies. The
packaged main process ships Electron/Node built-ins and the `electron-updater` runtime; no Next.js server or
website dependency tree is shipped. The website's Next.js dependency is updated
within v15, with patched PostCSS/Sharp overrides for known dependency advisories.

The build bundles the native engine and its adjacent `lib/handwork` runtime files
into `resources/<os>-<arch>/handwork`. End users do not need to install Handwork,
Node.js, npm, or Zig separately to use the desktop app's native engine. Optional
official runtime adapters retain their own external runtime requirements.
The default package command targets the host platform (Windows defaults to x64).
On macOS it creates `release/mac-arm64/Handwork.app`, an unsigned macOS arm64 application
using the Handwork app icon. Packaging requires Xcode 26 or later to compile
`electron/assets/Handwork.icon` into the native macOS icon catalog, which supports
light, dark, clear, and tinted appearances. After editing the icon source, run
`npm run desktop:icons` to regenerate the light/dark PNGs used by the development
Dock icon. Packaged apps use the native catalog without a runtime PNG override.
Local builds use an ad-hoc signature for development and do not qualify for public distribution. Signed macOS release builds are notarized by CI when release credentials are configured. Rebuild the desktop package
after changing the Zig engine so the bundled binary matches its protocol.

### Desktop updates

Every push to `main` in this repository runs desktop tests and typechecking, then
automatically syncs the desktop source to `loveconnor/handwork` and pushes a
release commit there. Its existing pipeline builds, signs, tests, and publishes
the app update to the same public feed used by installed apps. Pull requests run
checks without publishing. No manual sync is required.

The handoff uses the `HANDWORK_RELEASE_DEPLOY_KEY` Actions secret, a dedicated
write deploy key for `loveconnor/handwork`. Apple signing credentials remain in
the release repository. Build and publication progress appears in that repo's
Desktop release workflow, linked from this repo's release job summary.

For local recovery, source can also be synchronized manually:

```sh
node scripts/sync-release-source.mjs ../handwork
```

The sync copies tracked source files, removes deleted source files from the
release copy, and excludes repository workflows. Local dependencies,
credentials, and build outputs are never copied.

Pushes to `main` in `loveconnor/handwork` automatically build and test desktop
releases after every push to main. The workflow assigns a newer
version from the base desktop version and GitHub run number, builds Windows x64
and ARM64 installers with their matching engines, and tests installation, chat,
and an actual older-to-newer upgrade before publishing. The npm package has a
separate version and publishing process.

The sidebar checks for updates after launch and every six hours. Users can also
check manually, download an available update, and choose **Restart to update**.
Downloads never interrupt a chat. Restart is blocked during a running response;
unsent drafts and attachments are saved before installation and restored after
restart. Updates do not install automatically on ordinary app quit.

The updater reads the public `desktop-stable` release's architecture-specific
manifests. They point to immutable installers in `desktop-v<version>` releases.
The workflow uploads every installer before promoting any manifest; each download
is verified against its SHA-512 digest. Desktop releases do not replace the
repository's CLI/npm latest release. No GitHub token is embedded in the app.
Roll forward with a new push/version to undo a bad release; never overwrite bytes
for an already published version or lower a manifest version.

Existing apps without the updater need a one-time install of an updater-enabled
release. The Windows NSIS app identity remains `com.handwork.desktop` across
versions. Windows installers are unsigned unless `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` are configured in the repository's Actions secrets. Signed
builds also retain electron-updater's publisher verification.

macOS updates require a Developer ID signature. Configure these GitHub Actions
secrets to enable the macOS release job: `MAC_CSC_LINK` (base64 P12 certificate),
`MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. The job signs and notarizes DMG/ZIP artifacts and publishes
`latest-mac.yml` only on success. Until those credentials exist, Windows releases
continue and unsigned Mac builds explain that a signed release is required.
Never disable the Mac signature requirement to work around missing credentials.

For a signed release built on this Mac, create or import a **Developer ID
Application** identity using Xcode Settings > Accounts > Manage Certificates.
The certificate and its private key must appear in the login keychain. Configure
notarization through the secure interactive prompt:

```sh
xcrun notarytool store-credentials handwork-notary
```

Supply your Apple ID, Team ID, and an app-specific password in that local prompt.
Then build with the saved Keychain profile:

```sh
APPLE_KEYCHAIN_PROFILE=handwork-notary node scripts/desktop-package.mjs darwin arm64 --release
```

Packaging verifies the complete code signature. Public release builds must also
pass Gatekeeper assessment and stapled notarization ticket validation before the
packaging command succeeds. The DMG is signed, notarized, and stapled separately.
Update manifests are hashed again after stapling so their checksums describe the
final downloads. A local launch without quarantine is insufficient
release evidence. The withdrawn macOS preview failed signature verification and
must not be republished.

The release workflow is at `../.github/workflows/desktop-release.yml` in the
canonical repository. To test an actual upgrade on a Windows test machine:

```powershell
./scripts/windows-test/install.ps1 -Installer ./old-installer.exe -Architecture x64 -UpdateInstaller ./new-installer.exe -UpdateVersion 0.1.2
```

The test points only the test installation's update feed to a local HTTP fixture,
then uses the real sidebar buttons and real NSIS installer. It checks the new
installed version, automatic relaunch, and the up-to-date state. Test clients use
a restricted PATH; end users never need Node.js/npm/Zig/CLI installations.

### Windows installers

```sh
npm run desktop:package:win
npm run desktop:package:win:arm64
```

These commands create `release/Handwork-Setup-0.1.0-x64.exe` and
`release/Handwork-Setup-0.1.0-arm64.exe`. The NSIS installer offers a per-user
installation, an installation directory picker, and desktop/Start menu shortcuts.
Each installer bundles only its matching engine; it does not download or install
a separate CLI. Windows uses standard native window controls.
Provider settings are available before the first chat, so users can sign in or
save an API key entirely inside the app.

The NSIS payload uses ZIP with differential packages disabled. The older NSIS
7z extractor cannot decode the ARM64 filter emitted by the current archive tool;
that combination can leave an installation without its application files.

When packaging on a different OS or architecture, first stage the engine in the
sibling checkout with `node scripts/package-native.mjs --target=win32-x64` or
`--target=win32-arm64`. Native builds use `zig-out`; cross builds use
`prebuilds/<platform>-<arch>`. An explicit `HANDWORK_BINARY` may point to another
trusted executable, provided its runtime files are at `../lib/handwork` relative
to its containing directory. Packaging checks the executable format and CPU
architecture and fails if the engine or runtime is missing.
The engine must accept at least 128 KiB of ACP response instructions: the full
standalone chat catalog exceeds the previous 64 KiB limit. The sibling engine's
`src/acp/server.zig` includes this limit increase; rebuild the native packages
after pulling that change.

Run `npm run test:desktop` and `npm run typecheck` before packaging. On Windows,
check the x64 unpacked package with:

```powershell
node scripts/desktop-smoke.mjs release/win-unpacked/resources
```

For ARM64, use `release/win-arm64-unpacked/resources` on an ARM64 Windows machine.
The smoke check starts the bundled engine and verifies the desktop ACP handshake
without contacting a model provider. Before distributing, also install and launch
the installer on Windows and check provider login, chat streaming, folder/file
pickers, approvals, cancellation, and reopening saved chats. Cross-packaging on
macOS does not verify those Windows behaviors. The engine's Windows support is
experimental; interactive PTY tools and clipboard image capture remain limited.

For an installer-level test on a Windows test machine with Node.js available to
the test harness, run:

```powershell
./scripts/windows-test/install.ps1 -Installer ./release/Handwork-Setup-0.1.0-x64.exe -Architecture x64
```

This installs into a temporary directory with spaces and Unicode characters,
launches the installed app with Node/npm/Zig/Git/Handwork absent from its PATH,
checks first-run sign-in controls, enters a fixture API key through Settings,
and sends a message through the chat composer to a local model fixture. It then
uninstalls the app. Logs, screenshots and the installer SHA-256 are saved under
`windows-test-results-<arch>`. The harness uses Node.js to drive the test; the
installed application does not inherit access to that runtime. No live provider
account or paid model request is used. Set `RUNNER_TEMP` to a temporary directory
when running outside GitHub Actions.

The rebuilt x64 and ARM64 installers passed the [native Windows installer
verification](https://github.com/loveconnor/handwork/actions/runs/38847244281)
on Windows Server 2025 x64 and Windows 11 ARM64. The run exercised installation,
first-run provider setup, a chat response and uninstall with developer tools
absent from the app's PATH. Local reports and matching installer SHA-256 digests
are saved under `release/windows-validation`. These are hosted test images with
a restricted PATH, rather than factory-reset consumer PCs. Live provider OAuth
and optional runtime adapters were not exercised; the installers remain unsigned.

### Implemented first slice

- Native folder selection and supervised Handwork ACP process.
- Real streaming messages, tool input/output/status, and explicit permission cards.
- Cancellation, error states, saved session listing/loading, and fresh sessions.
- Engine-provided model/provider/effort/session-mode controls; no fictional models.
- Shared harness appearance, project/sidebar navigation, chat tabs, and theme.
- Sandboxed renderer and a narrow preload API; no renderer shell or file access.

Message actions match the Honest AI playground: icon-only Copy and, on the
latest reply, Regenerate. User-message Copy and Edit appear on hover, keyboard
focus, and touch. Save & regenerate uses the native `session/rewind` extension
to seed a durable replacement chat with the canonical turns before the selected
message, then submits the revision. The old version stays in saved chats. This
rewinds model context, not workspace file changes or command effects. Stale
message targets are rejected. Editing image-bearing messages is currently
unavailable; their Copy action remains available.

Only one conversation runs at a time. Switching chats loads saved history; it
never replays tool effects. Stop does not undo edits or arbitrary shell effects.
The engine remains responsible for permissions, session persistence, and tools.

### Not yet full CLI parity

MCP/skills management screens, interactive terminal attachment, source-code
diff controls, advanced session
commands, richer subagent views, and official Codex/Copilot runtime selection
remain follow-up work. Existing engine integrations can still run through agent
tools where ACP supports them. Unsupported inbound protocol requests fail closed.
No raw model-generated HTML is executed. The browser `/harness` preview deliberately
has no native privileges and explains how to start Electron.

## Original component gallery

The Next.js gallery and its original documentation remain below. Desktop uses a
separate Vite entry without the website's analytics, email capture, server routes,
or remote Google font build dependency. The original MIT attribution is preserved.


Crafted, copy-paste interface primitives for AI-native products — thinking and
reasoning states, streaming answers, human-in-the-loop approvals, tool-call and
task status, records and diff tables, prompt bars, and more — plus a live
**harness** that arranges them into a working agent chat.

Everything is one self-contained component per primitive, built on a small
design-token layer. MIT licensed. Take it, wire it to your own agent, ship it.

- **Gallery:** every primitive as a live, copy-paste demo — `/`
- **Harness:** the primitives composed into an agent chat — `/harness`

## Quick start

```bash
git clone https://github.com/slev12397/beautiful-ui.git
cd beautiful-ui
npm install
npm run dev
```

Open http://localhost:3000. Analytics and email capture are optional (see
[Environment](#environment)) and are excluded from the Electron entry.

`SidebarNav` now uses local SVG icons from `components/atoms/SidebarIcons.tsx`.
No commercial icon license key is required.

Stack: Next.js (App Router) · React · Tailwind CSS v4 · TypeScript.

## What's in here

```
app/
  globals.css              design tokens (:root, .dark, @theme) + component CSS
  layout.tsx               fonts (Inter + JetBrains Mono), theme boot
  page.tsx                 the gallery
  harness/page.tsx         the harness route
components/
  primitives/*             the library — one self-contained file per primitive
  site/*                   the shell/chrome (harness, gallery grid, theme, sounds)
lib/
  meta.ts, registry.tsx    the gallery catalog
```

The primitives are the product. Most files under `components/primitives/` paste
in on their own; some also import a shared building block (`Button`, `GlideMenu`,
`EntityChip`, …) or an npm package (`liveline`, `glimm`, `iconoir-react`, …). Every
component's exact dependencies are listed on its gallery card, and the
[component registry](#install-a-component) resolves them for you automatically.

## Install a component

**Recommended — the CLI resolves the whole dependency tree** (internal building
blocks, npm packages, and only the CSS a component actually needs):

```bash
npx shadcn add https://www.beautifului.dev/r/approval-card.json
```

Browse the index at
[`/r/registry.json`](https://www.beautifului.dev/r/registry.json). Each item
declares its `registryDependencies`, npm `dependencies`, and `files`, so one
`add` pulls the component, its building blocks, installs its packages, and drops
in the foundation plus any component-specific CSS (e.g. `records-table.css`) —
not the whole stylesheet.

**Manual — copy-paste:** open a component's code view in the gallery; it lists
exactly what to also copy and `npm i`. Add the [foundation](#one-time-setup)
once, then paste the component and anything under "Requires".

## The design system

Tokens live in `app/globals.css` as Tailwind v4 `@theme` variables, themed for
light and dark from the same source:

- **Cool, blue-tinted neutrals**, solid hairline borders (not alpha), one blue
  accent, semantic color (green/orange/red) used sparingly.
- **Tight radii** — chip `6` · control `8` · card `10` · window `14` · pill.
- **Restrained, layered shadows** — hairline · btn · card · raised · overlay.
- **Type** — Inter (tight tracking, tabular numerals) + JetBrains Mono.

### One-time setup

A single component is **not** self-contained on its own — it renders on this
shared foundation stylesheet. Before pasting any primitive, drop
[`app/globals.css`](https://github.com/slev12397/beautiful-ui/blob/main/app/globals.css)
into your project **in full, once**. It contains everything the components rely on:

- `@import "tailwindcss"` and `@import "shadow-plugin/unprefixed"` (the smooth
  `--shadow-xs … --shadow-lg` scale that `shadow-card` / `shadow-overlay` build on)
- the `:root` / `.dark` variables **and** the `@theme inline` block that maps them
  to the utilities (`bg-ink`, `text-ink-3`, `shadow-overlay`, `rounded-window`, …)
- every `@keyframes` (`pop-in`, `fade-up`, `shimmer-text`, `pixel-on`, `stream-in`, …)
  and the `prefers-reduced-motion` fallbacks

The `:root`/`.dark` variables **alone won't work** — the `@theme inline` block is
what makes those utility classes exist. It's framework-agnostic: the same file
works in Vue, Svelte, or plain HTML on Tailwind v4.

## Wiring the harness to a real agent

`components/site/IceCreamHarness.tsx` is a demo: a `SCENARIOS` map turns fake
prompts into scripted replies built from the primitives. To make it real,
replace the demo data with your backend — the primitives stay exactly as they
are; they're just the rendering layer for your agent's output.

| Demo seam | Replace with |
| --- | --- |
| `SCENARIOS` / `matchScenario` in `IceCreamHarness.tsx` | your agent request per user message |
| `StreamingText` / `StreamLine` | your token stream (SSE or the [AI SDK](https://ai-sdk.dev) `streamText`) |
| `ThinkingState` | your agent's reasoning / step events |
| `ToolChips` | your tool-call events and their results |
| `ApprovalCard` | your human-in-the-loop confirmations |
| `ContextCards` | your retrieval / memory chunks |
| `RecordsTable` / `DiffTable` | your data and proposed edits |
| model picker in `PromptBar` | your available models |

A typical production wiring:

1. **Models** — call your LLM from a Next.js route or Server Action. On Vercel,
   the [AI SDK](https://ai-sdk.dev) + AI Gateway lets you use `"provider/model"`
   strings and stream tokens straight into `StreamingText`.
2. **Streaming** — stream tokens (SSE / `ReadableStream`) into the streaming
   primitives; they render word-by-word as data arrives.
3. **Tools & approvals** — map your agent's tool-call and confirmation events
   onto `ToolChips`, `ThinkingState`, and `ApprovalCard`.
4. **Memory & context** — feed your retrieval/memory results into `ContextCards`
   and the side pane; persist threads however you like (the harness keeps them
   in local state for the demo).
5. **Data** — point `RecordsTable` / `DiffTable` at your real rows.

## Environment

All optional. Copy `.env.example` to `.env.local` to enable them.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | PostHog analytics (client) |
| `NEXT_PUBLIC_POSTHOG_HOST` | PostHog host |
| `RESEND_API_KEY` | email capture via Resend (server-only) |

Without them, analytics is disabled and the email-capture endpoint returns a
graceful "unavailable" — nothing crashes.

## License

MIT — see [LICENSE](./LICENSE). Built by [Turbo](https://turbodesign.co).

New-chat suggestions are generated in the background with the selected provider and model from a bounded project snapshot: file paths, README/manifests, excerpts of changed source files, Git changes and commit subjects, and recent chat titles. Hidden and obvious credential files and files outside the chosen folder are excluded. The background session cannot use tools or save chat history. Suggestions are cached per project and model for five minutes and refreshed when the snapshot changes. Clicking a suggestion only fills a draft; it does not run the task. Generation errors offer a retry without blocking the composer.

Each sidebar chat has a menu for Rename, Pin/Unpin, Close tab (when open), and Delete. Desktop names and pins are stored in `chat-preferences.json` in the app’s user-data directory and applied to project lists, recents, search, and tabs. They do not replace the native engine’s generated titles. Closing a tab preserves the saved chat; Delete requires confirmation.

### Desktop settings

Open Settings from the sidebar or with **⌘, / Ctrl+,**. The seven sections cover appearance and text sizes, sending and startup behavior, default models, provider connections, tool permissions, additional project folders, instruction files, background suggestions, notifications, local data, and diagnostics.

App preferences and startup tabs are saved in Electron’s user-data directory in `desktop-settings.json`. Model, mode, and suggestion defaults can be overridden per project. These defaults apply to new chats; the composer controls the current chat. Project overrides can be reset without changing instruction files or native permission rules.

Global instructions edit `~/.handwork/AGENTS.md`; project instructions edit the project’s `AGENTS.md`. Instructions require an explicit save, protect unsaved edits on close, and reject stale saves when another editor changed the file. Permissions and additional folders use the native engine’s locked settings writer and require reconnecting the project before the next prompt.

Chat exports are JSON containing user and assistant text. They exclude tool outputs and attachment bytes. Removing saved attachment snapshots requires confirmation because attachments referenced by older chats will become unavailable. Diagnostics contain versions, platform, default provider, and attachment totals, with no paths, keys, or message contents.

Connection tests send a short provider request without tools or saved chat history. Background suggestions can be disabled globally or per project. Both may use provider credits. Notification text is generic; the operating system controls whether notifications and sound are delivered.

Updates are checked against published Handwork desktop assets. This build uses manual downloads; it does not install updates automatically.
