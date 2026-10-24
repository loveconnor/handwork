# Handwork Desktop

Handwork's React/Tauri desktop workspace and native feature stack, with Handwork as the default coding engine. The Handwork engine remains a separate native process, speaking ACP over supervised stdin/stdout.

## Run

Requires Node.js 24+, a stable Rust toolchain, and the platform's Tauri development prerequisites. On macOS, install Xcode Command Line Tools.

```sh
npm ci
npm run desktop:dev
```

The desktop command stages the engine and its complete runtime from the sibling `../handwork/zig-out` build. Set `HANDWORK_BINARY` to use another Handwork build with its matching `../lib/handwork` runtime. The source engine must already be built.

```sh
npm run desktop:build             # compile the native application
npm run desktop:package           # package the application with its engine
npm run desktop:package -- --debug # development bundle
```

`npm run dev` starts only Vite; native features require `desktop:dev`. `npm run build` checks TypeScript and builds all three renderer entries: the workspace, quick composer, and floating Mono chat.

## Engine and providers

New sessions default to **Handwork**, which reuses `~/.handwork` configuration and credentials. Its model catalog is discovered from connected Handwork providers. Configure a connection with the native engine's `handwork login <provider>` command. The provider/model picker selects the upstream provider before the model; reasoning settings remain engine-owned.

Handwork sessions support streamed answers and reasoning, tools, approval cards, attachments, cancellation, saved engine session bindings, and resume after parking or restart. Supervised, automatic review, automatic edits, and planning use Handwork's `ask` mode with the client's selected approval policy applied to ACP permission requests. Full access uses `code`. Planning denies non-read permission requests. Background titles, commit messages, pull request content, and side questions use isolated, unsaved, tool-free Handwork sessions.

Direct harness integrations remain available. Its editor and file browser, terminals, source control and worktrees, session tabs and search, automations, orchestration, quick composer, floating chats, remote host, mobile link, themes, settings, skills, and MCP modules are included. A remote host can run Handwork when its executable and runtime are installed on that machine.

The native application identifier remains `com.handwork.desktop`. Existing Handwork engine sessions and credentials are not deleted. The replaced Electron application's UI-specific preferences/history are not automatically converted into the SQLite workspace format. Renamed application storage keys, command names, and pairing protocols do not migrate settings or pairings from earlier branding.

## Validation

```sh
npm run typecheck
npm test
npm run host:build
npm run test:host
cargo check --workspace --all-targets
cargo test --workspace --lib
npm run test:browser
```

The imported feature tests are retained. Browser tests use fixtures; native provider authentication, external integrations, remote machines, and mobile pairing also require their own configured accounts/devices for end-to-end testing.

## Source and attribution

Includes a third-party desktop workspace source snapshot (version 0.16.0), authored by Nick under MIT. Application names, identifiers, and protocol/storage keys use Handwork branding. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The [Handwork documentation](docs/building.md) describes the preserved native stack. For this checkout, use the `desktop:*` commands above so packaged apps include Handwork. The old Electron release-sync workflow has been replaced with validation; this migration does not publish a release.
