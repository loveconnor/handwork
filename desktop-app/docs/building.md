# Build from source

The desktop app uses Electron. Rust is required only for the shared mobile transport in `crates/mobile-link/`; the retired Tauri backend is no longer part of the repository.

## Prerequisites

- Node.js 24+ and npm.
- A stable Rust toolchain, with the target for the platform you are building.
- A built Handwork engine and its matching runtime. The default location is `../handwork/zig-out`; set `HANDWORK_BINARY` to use another engine binary. Its `../lib/handwork/cli.mjs` runtime must also be present.
- On macOS, Xcode Command Line Tools.

## Run and build

From the repository root:

```sh
npm ci
npm run desktop:dev
npm run desktop:build
npm run desktop:package
```

`desktop:dev` launches Electron. `desktop:build` builds the renderer and stages the engine, offline dictation, and Rust mobile helper. `desktop:package` builds and packages the app into `release/`. `npm run dev` and `npm run build` are for the standalone Next.js site.

For Windows packaging, use `npm run desktop:package:win` (x64) or `npm run desktop:package:win:arm64` with the corresponding native engine and Rust target available. Packaging configuration lives in the `build` section of `package.json`.

## Mobile transport

Both Electron and the phone app use `crates/mobile-link/`. Electron bundles the `handwork-mobile-host` executable, which provides encrypted QUIC transport while Electron owns pairing configuration and workspace operations.

```sh
npm run mobile:transport
cargo test --locked -p handwork-mobile-link --features desktop-host
```

See [the mobile README](../mobile/README.md) for phone builds and pairing.

## Validation

```sh
npm run typecheck
npm test
cargo test --locked -p handwork-mobile-link --features desktop-host
npm run desktop:build
```

## Automatic desktop releases

Pushing to `main` runs [desktop checks](../.github/workflows/desktop-release.yml), then syncs the source and [Electron release workflow](../scripts/ci/desktop-release.yml) into `loveconnor/handwork`. Pull requests run checks without releasing.

The release workflow builds an Apple Silicon Mac app and Windows x64 and ARM64 installers with the native engine and mobile transport. It handles signing, installation checks, and publication. Consult the workflow for its current runner, credentials, and artifact requirements.
