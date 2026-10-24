# Build from source

Handwork supports macOS, Linux, and Windows. You need Node.js 24+ and a current stable Rust toolchain. Install and sign in to at least one agent CLI using [provider setup](providers.md).

## Platform prerequisites

On Linux, install the standard Tauri prerequisites, including `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, and `libjavascriptcoregtk-4.1-dev` on Debian/Ubuntu. The setup helpers below install the native dependencies and packaging tools for their distributions.

On Windows, the packaging script uses `stable-x86_64-pc-windows-msvc`. The installer bootstraps the [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) runtime when it is missing.

## Run locally

From the repository root:

```bash
npm install
npm run tauri dev
```

## Ubuntu / Debian packages

On an Ubuntu/Debian workstation, the repository can install the native Tauri prerequisites and build distributable Linux packages directly:

```bash
npm run setup:linux:deb
npm ci
npm run build:linux
```

The Linux build emits `.deb` and AppImage bundles under `target/release/bundle/`, in the `deb/` and `appimage/` directories. `build:linux` repacks the AppImage so it uses the host WebKitGTK 4.1 stack instead of bundled Ubuntu libraries. See [Linux installation](install.md) for runtime dependencies and package instructions.

## Fedora / Enterprise Linux packages

On Fedora or Enterprise Linux 10 (registered RHEL, Rocky, Alma, CentOS Stream, Oracle):

```bash
npm run setup:linux:fedora
npm ci
npm run build:fedora
```

On EL 10, the setup helper enables EPEL 10 and CRB automatically, since the development packages need CRB. On Oracle Linux it enables `ol10_codeready_builder` and `ol10_developer_EPEL`. Fedora does not need these extra repositories.

The build emits a `.rpm` under `target/release/bundle/rpm/`, installable with:

```bash
sudo dnf install ./target/release/bundle/rpm/Handwork-*.rpm
```

EL 9 and older are unsupported (`webkit2gtk4.1-devel` only exists in EPEL 10). The published release `.rpm` is built on Enterprise Linux 10 so it loads on Fedora and EL 10. See [Linux installation](install.md#fedora--enterprise-linux-packages) for release package installation and runtime repository setup.

## Windows packages

```bash
npm ci
npm run build:windows
```

The Windows build emits an NSIS installer under `target/release/bundle/nsis/`.

For the desktop app with its bundled Handwork engine, use `npm run desktop:package` on the target platform. Set `HANDWORK_BINARY` to a native engine built from `loveconnor/handwork`; its `../lib/handwork/cli.mjs` runtime must also be present. The default development location is `../handwork/zig-out/bin/handwork` (`handwork.exe` on Windows).

## Tauri configuration

- [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) contains the shared application and bundle configuration.
- [src-tauri/tauri.linux.conf.json](../src-tauri/tauri.linux.conf.json) loads automatically for Linux development and builds.
- [src-tauri/tauri.windows.conf.json](../src-tauri/tauri.windows.conf.json) loads automatically for Windows development and builds.

## Automatic desktop releases

Pushing a committed change to `main` runs [desktop checks](../.github/workflows/desktop-release.yml), then syncs the tracked desktop source and [Tauri release workflow](../scripts/ci/desktop-release.yml) into `loveconnor/handwork`. That repository holds the engine source and existing Apple signing credentials. Pull requests run checks without releasing.

The release workflow builds an Apple Silicon Mac `.dmg` and Windows NSIS `.exe` installers for x64 and ARM64, each with the native engine and its runtime. The Mac app is signed and notarized. Windows installers currently have Tauri update signatures but no Authenticode certificate configured. New releases get an increasing version from the base package version and the release workflow run number; JavaScript, Rust, and Tauri versions are updated together in CI.

All three builds must succeed before anything is published. Versioned installers and updater signatures go to `desktop-vX.Y.Z` releases in [loveconnor/handwork](https://github.com/loveconnor/handwork/releases). Only then is `desktop-stable/latest.json` promoted. That feed points to immutable, versioned downloads; existing Electron `.yml` feeds are left intact.

Required GitHub Actions secrets:

- `handwork-desktop`: `HANDWORK_RELEASE_DEPLOY_KEY`, with write access to `loveconnor/handwork`.
- `handwork`: `MAC_CSC_LINK` (base64 P12), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and `TAURI_SIGNING_PRIVATE_KEY`. An encrypted updater key also needs `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The updater public key is in `src-tauri/tauri.conf.json`; its matching private key belongs only in the release repository's Actions secrets. Keep the same key for future releases. Follow the [Tauri updater documentation](https://v2.tauri.app/plugin/updater/) when rotating keys.

## Checking, downloading, and installing updates

The app checks at launch and hourly, with an additional throttled check when the window regains focus. Settings and the application menu include **Check for updates**. An available update appears in the sidebar and Settings. **Download** fetches and verifies it while the app stays open; **Restart to update** saves the workspace and starts installation. Active responses must finish or be stopped before restarting. Failed downloads can be retried.

The first Tauri release must be installed manually over an older Electron build: the two frameworks use different update formats. Subsequent Tauri releases use the in-app updater. The automated release currently targets Apple Silicon Mac and Windows; Linux packages can still be built locally and `.deb`/`.rpm` installations use their package manager.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines and checks. The experimental remote host has its own [build and packaging instructions](remote-access.md#release-packaging).
