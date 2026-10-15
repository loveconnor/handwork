# Windows port status

Windows support is experimental. Windows x64 has native GitHub Actions checks
for installation, commands, settings, saved sessions and networking. Windows
ARM64 is cross-compiled only. Publishing the prepared npm package is a separate
release step; the implementation does not publish automatically.

## Implemented

- Startup reads the original Unicode Windows command line and environment.
  `USERPROFILE` supplies `HOME` when `HOME` is absent. Console input, UTF-8 / VT
  output, dimensions, raw mode and restoration use Windows APIs.
- Settings, session logs, managed session files, history, usage, credentials and
  private artifacts use protected ACLs. Creation grants access to the current
  user and SYSTEM before content is written. Verification rejects foreign
  owners, broad grants, reparse points and hard links. Read snapshots retain
  their identity if atomic replacement unlinks them; mutation handles require a
  linked file. Durable settings and session commits report directory-flush
  failures. New sessions close child files before directory publication, retain
  the directory handle across rename, then reacquire the writer and reject
  intervening changes.
- The pinned HTTP fetcher uses nonblocking Winsock, `WSAPoll`, socket error
  inspection and bounded send/receive operations. OAuth callback polling and
  socket timeouts use Windows operations. Browser sign-in opens HTTP(S) URLs
  through `ShellExecuteW`; manual code entry remains cancellable.
- Captured commands use the system Command Prompt by default. Explicit
  PowerShell profiles use UTF-16 encoded commands. Command Prompt source uses a
  private batch file to preserve quotes and Unicode. Owned children start
  suspended, join a Job Object, and resume after assignment. Cancellation,
  timeout, normal leader exit and job closure clean up descendants. Process
  tokens use creation times; external termination checks the token on the same
  open process handle it terminates.
- The npm launcher selects macOS ARM64, Windows x64 or Windows ARM64 binaries,
  verifies their executable architecture, and preserves arguments without a
  shell. The package includes runtime assets alongside each executable. Release
  packing refuses missing targets. Global npm update detection recognizes the
  new package layout.

## Verification

On a Windows machine with Zig 0.16.0, Node.js and npm, run from PowerShell:

```powershell
./scripts/test-windows.ps1
```

The script stages the native ReleaseFast package and runs console, ACL, path,
loopback socket,
process identity and descendant cleanup tests. Integration tests cover settings,
prompt history, session creation and resume, private read snapshots, Unicode
paths, command quoting, separate output streams, exit status and timeout.

The CLI smoke test uses a local HTTP provider with a dummy API key. It performs
API-key login, runs foreground and background commands that create Unicode-named
files, saves the conversation, and resumes that conversation in another process.
It does not call a paid model.
The PowerShell script also packs and installs into a temporary npm global prefix
and invokes npm's actual Windows command shim, then repeats the full CLI journey
through the installed launcher. Its partial-architecture package
is only a test fixture; release packing requires all three targets.

`.github/workflows/windows.yml` runs these checks in named steps on GitHub's
native Windows runner after a push, pull request or manual dispatch. It also
checks public DNS, HTTPS and system certificate trust against the Zig download
index. Set `HANDWORK_E2E_PUBLIC_HTTPS=1` to enable that Internet-dependent check
when running locally. Individual native tests have a 60-second deadline.

On this Mac, the shared storage integration and CLI smoke test run with:

```sh
zig build test-platform
zig build test-platform-integration
node scripts/windows-smoke.mjs
npm run test:npm-launcher
```

Compile Windows adapters and application-facing integration tests without
executing them:

```sh
zig build platform-check -Dtarget=x86_64-windows-gnu
zig build platform-check -Dtarget=aarch64-windows-gnu
```

Cross-compilation validates compilation and linking. It does not establish that
Windows ACLs, directory flushing, console events, process supervision or npm
installation work at runtime.

## Packaging

On the Apple Silicon build host, stage the three supported binaries and their
runtime files, then create a local tarball:

```sh
npm run package:native
npm pack
```

`package:native` builds ReleaseFast executables. `prepack` checks that every
supported executable exists and has the correct architecture. To stage one
architecture separately, use, for example:

```powershell
node scripts/package-native.mjs --target=win32-x64
```

This stages files locally and never publishes. Run the native Windows checks
before publishing a package that advertises Windows support.

## Remaining limitations and release gates

- The full native CLI/npm journey must pass before release. Directory flushing,
  ACL repair, console mode restoration, socket exchange and owned descendant
  cleanup have passed on Windows. Manual login, editing, permission approval /
  rejection, cancellation, resize, exit and resume in Windows Terminal and
  VS Code still require an interactive walkthrough.
- Managed interactive terminals (`tty: true`) still use the existing Unix PTY
  host and remain unsupported on Windows. Captured commands (`tty: false`),
  including managed background execution, use the Windows command runner.
  A Windows ConPTY / terminal-host implementation remains required for parity.
- Clipboard image capture remains macOS-only. Windows users can attach an image
  by path. Background binary self-replacement is disabled on Windows; use npm
  updates or rebuild source installations.
- The broader settings test suite has three failures and one crash in legacy
  settings migration tests. The same failures were reproduced in an isolated
  copy using the original settings-store source. The focused HTTP transport,
  history and new platform integration checks are separate from those failures.

## API references

- [Windows file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
- [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
- [AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck)
- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
- [ShellExecuteW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew)

- [Command Prompt variable expansion](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)

- [Synchronous and asynchronous file positions](https://learn.microsoft.com/en-us/windows/win32/fileio/synchronous-and-asynchronous-i-o)
- [Windows directory rename requirements](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/87f86c9b-6c2a-4803-84b7-131a74a434fa)
