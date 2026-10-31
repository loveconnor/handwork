# Handwork Desktop

Handwork's Electron desktop app, restored from the last Electron revision before the Tauri migration. The original desktop interface, native Handwork engine, saved-chat stores, Git tools, offline dictation, and packaging are active again. The Expo mobile app remains in `mobile/`.

## Run

Requires Node.js 24+, Rust stable (for the mobile transport helper), and the built Handwork engine in `../handwork/zig-out`. On macOS, install Xcode Command Line Tools. Set `HANDWORK_BINARY` to use another engine build with its matching `../lib/handwork` runtime.

```sh
npm ci
npm run desktop:dev
npm run desktop:build
npm run desktop:package
```

`desktop:dev` launches Electron. `desktop:build` builds its renderer and stages the engine, dictation, and mobile transport. `desktop:package` creates a local application in `release/`. `npm run dev` is the standalone Next.js site, not the desktop app.

## Mobile

Keep using the existing Expo app. In Electron, open **Settings → Mobile**, enable mobile access, and choose **Pair phone**. Scan the QR code or copy the pairing link. The desktop and phone share the existing QUIC/mutual-TLS protocol. A small Rust child process provides only transport; Electron owns the workspace, pairing configuration, and OS-encrypted identity. It exits with the desktop and is bundled inside packaged apps.

Pair again after switching from Tauri: Electron uses its own pairing identity and workspace stores. Existing mobile selections can be chosen again after pairing. Existing Tauri application data is left on disk, but its SQLite workspace and provider-specific histories are not automatically imported into Electron. Existing Electron and Handwork engine history remains available.

Supported mobile operations include project/chat lists, reading and streaming conversations, starting and sending messages with attachments, stopping turns, model and permission choices, renaming/archiving/deleting sessions, browsing/searching project files, viewing changes, staging, and committing. Models come from Electron's Handwork providers. Agent approvals remain on desktop. Tauri-specific provider profiles, Monos, automatic router mapping, worktree creation, and mobile Git sync/PR actions are not implemented by this bridge; add existing worktrees as desktop projects and use desktop Source Control for sync/PRs.

Use the same Wi-Fi network, or set a reachable VPN/remote address before pairing. Outside the LAN, UDP port 38416 must be reachable. The desktop must stay awake and running. Pairing codes expire after 15 minutes, work once, and can be cancelled. Revoke phones from Settings → Mobile.

See [mobile/README.md](mobile/README.md) for phone builds. No phone source or native protocol changes are required for this restoration.

## Validation

```sh
npm run typecheck
npm test
cargo test --locked -p handwork-mobile-link --features desktop-host
npx vitest run --config mobile/vitest.config.ts
npm run lint --prefix mobile
```

The mobile tests exercise the unchanged phone invitation parser and transcript reducer against the Electron adapter. Rust tests exercise encrypted QUIC, peer revocation, watch streaming, and the actual Electron transport subprocess. Physical phone pairing and external provider credentials still need a configured device/account.

The retained `src/` and `host/` trees are the previous desktop frontend and remote host, not the active Electron build. The Tauri Rust backend and its vendored terminal library have been removed. The Cargo workspace contains only the shared mobile transport in `crates/mobile-link/`. CI and the signed release workflow use Electron packaging.
