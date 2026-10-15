# Desktop installation and Android QR validation — 2026-10-15

Status: **full phone user journey has not passed**. The public runtime mismatch described below is addressed by desktop preview.21 bundling matching launcher/runtime tarballs. Final Windows installer installation verification passed; both desktop installers are publicly released. Android camera/UI interaction remains pending after native desktop-control failures.

## Actual installation probe

The packaged macOS app was launched with a new desktop user-data directory and an empty discovery directory. Before the test, `~/.agentroam/desktop-cli/0.2.0-preview.48` did not exist. The shipped bootstrap worker downloaded managed Node 22.22.0 and installed the pinned public npm dependencies. It stopped during runtime validation: the official `agentroam-runtime-darwin-arm64@0.2.0-preview.48` manifest has no `capabilities.nativeConsole` marker. Independent retrieval of the official tarball manifest and installed-file inspection confirmed this.

This was a clean component installation on an existing Mac, not a fresh OS/user install. Existing background service configuration was not replaced or restarted.

The misleading network-only failure hint was corrected. A real worker/parent integration rerun now returns `phase: error` with “当前安装包与运行组件版本不兼容，请下载配套的新版本。” Compatibility validation remains enforced. A synchronized new CLI/runtime release is required before installer acceptance can pass; this session did not publish anything.

## Component execution

Using the newly installed public launcher, a restricted system PATH and independent data directory, `doctor` exited 0. It exercised PTY and SQLite and downloaded managed Codex 0.162.1 plus Cloudflare. Actual `codex --version` and `cloudflared --version` passed. This proves installation/executable readiness, not Codex account authorization or a completed AI turn. Remote desktop OS permissions and live viewing/control are unverified.

## Actual gateway and pairing implementation

An independent gateway runs on loopback port 43127, with host-file access restricted to `/tmp/agentroam-pairing-e2e/workspace` and independent data/discovery directories. Desktop `SharedServiceConnection.mobilePairing()` generated the SVG through the real admin API. A PNG rendered from the SVG was decoded by Apple's Vision QR recognizer. The actual `NativePairingClient` then exercised:

- QR exchange and rejection of one-use QR replay.
- Authorized status and native console bootstrap.
- Native nonce WebSocket connection.
- Real PTY startup, shell command execution and observed output `AGENTROAM_PTY_OK`.
- Credential resume through a host-side storage adapter.
- Device revocation, socket close code 4003, HTTP rejection and credential removal.

This probe used an in-memory credential adapter and mapped emulator host alias `10.0.2.2` to host loopback. It did not exercise Android camera, Android Keystore, avatar directory UI or a public tunnel. Private grants/tokens are omitted from reports.

Evidence: `/tmp/agentroam-pairing-e2e/service-probe-report.json`, `bootstrap-report.json`, `doctor.log`, and verification source `service-probe.ts`.

## Android installation and UI boundary

The first emulator launch failed because the globally installed emulator lacked its QEMU executable. A complete emulator 37.2.12 was downloaded from Google, matched the official SHA-1 `3af4fe44ce82b3d88ae5678a53735f27ad729c15`, and extracted under the temporary validation directory. Existing global emulator files were not changed. A read-only AVD session booted Android 11/API 30. The final debug APK installed successfully via adb; target SDK 35, package `com.agentroam.mobile`. Existing AVD userdata remains protected by the read-only overlay.

Native UI control failed with `cgWindowNotFound` and repeated timeouts, including Finder. The emulator executable cannot be selected by that control tool. An asynchronous question is pending for explicit use of adb UI actions and Electron debugging, as required by the native-control tool instructions. No fallback UI actions have been performed without that answer. The existing ego-browser TaskSpace 5 remains handed to the user and was not reclaimed.

No physical Android device is attached. Native camera scan, resulting full-home layout/avatar/computer memory, relaunch behavior, remote desktop and physical-device acceptance remain open.

## Fix verification and artifacts

Five bootstrap/inventory tests passed using a temporary Vitest config that includes the `.test.mjs` inventory file (the repository's default test include does not match it). Desktop TypeScript checking, bootstrap typecheck/bundle, desktop compilation, unsigned macOS app packaging and `git diff --check` passed. Packaged main contains the compatibility error mapping, and the packaged worker matches the built source, SHA-256 `4669d83173a29c37c483275cc065cfacf3f66cf388274fd1104845379b882f52`.

Updated macOS app: `/tmp/agentroam-pairing-e2e/desktop-package/mac-arm64/AgentRoam.app`.
Android APK: `/Users/caoqu/team-agent/customer-agent/packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

During the initial phone probe, unrelated dirty source changes were preserved and temporary workspace dependency staging restored all original symlinks. That phase made no commit/push/npm release or existing service restart; the later isolated desktop release is recorded below.

## Desktop preview.21 release follow-up

The final Windows x64 NSIS and macOS arm64 DMG bundle launcher/runtime 0.2.0-preview.49, including nativeConsole capability 1. These private bundled components have not been published to npm. Both packaged bootstrap workers check platform, exact versions and SHA-256 before installation. The service start argument regression is covered by the real CLI parser.

A fresh macOS component installation with these bundled tarballs passed native inventory, real PTY, SQLite, Codex 0.162.1 execution and cloudflared. A second isolated gateway using the new runtime passed QR image decoding, native pairing, replay rejection, nonce WebSocket, real PTY output, credential resume and revocation. The test gateway on port 43221 was stopped after verifying PID, cwd and listening address.

Both installer ASARs, unpacked resources and bundled tarballs contain no wake-word model weights or model directories. First-launch bootstrap does not download wake-word models. Evidence: `/tmp/agentroam-desktop-release-20261015/voice-model-audit.json`.

Windows hosted-runner installation currently passes checksum verification and NSIS silent installation. Initial CI failed because the PowerShell invocation did not wait for the GUI executable used in Node mode; the harness now waits and reads the process exit code. Runtime preparation and shell checks remain pending until the new run completes.

## Windows doctor process lifetime fix

The actual Windows runner showed every doctor check passed, including real PTY, SQLite and managed Codex 0.162.1. The process then stayed alive until the five-minute worker timeout. An initial finally/kill workaround let doctor exit but produced an AttachConsole helper error. The final implementation probes real Windows cmd PTY output and exit in an owned Node subprocess, then exits that subprocess to release all handles. POSIX retains its prior lifecycle. Source: c627fb720ad5c7dfbb46944176fc5598527f562b.


## Candidate Windows integration passed

Run https://github.com/tclxqu-cao/team-agent/actions/runs/38760517409 passed installer checksum, NSIS installation, managed Node 22.22.0, runtime installation, doctor exit, managed Codex 0.162.1, background service ready with Cloudflare, SQLite, real cmd PTY, synthetic H264 remote helper self-test, unlock helper self-test, and desktop startup stable for 15 seconds. The installed CLI tarball was replaced with the exact candidate and its bundle manifest hash was updated, so this is component integration evidence. Final unmodified-installer acceptance is still required.

Windows Task Scheduler rejected a five-second restart interval. Native contract run https://github.com/tclxqu-cao/team-agent/actions/runs/38759739095 confirmed PT5S rejection and sixty-second acceptance. Service registration now uses one minute. Twelve focused native/service regressions passed.

Final packages rebuilt in artifacts-shipping and audited: both ASARs match the earlier complete privacy/model audit, bundle manifests verify, embedded native-runtime.js and windows-task-service.js match the c627fb7 build, and DMG verification passes. No wake-word models included.


## Final unmodified installer and public release passed

https://github.com/tclxqu-cao/team-agent/actions/runs/38762603351 passed on the rebuilt installer, with candidate_cli_sha empty. No installed component substitution occurred. All installer/bootstrap/service/native/helper/desktop startup checks passed; final doctor and smoke output had no AttachConsole error.

Public prerelease: https://github.com/tclxqu-cao/team-agent/releases/tag/desktop-v0.2.0-preview.21. Tag/source: 1d57064cb021f1267a148b1cbf847cdef1238ccd; binary functionality: c627fb720ad5c7dfbb46944176fc5598527f562b, later changes are workflow-only. Original CLI workflow restored. No npm publication.

Anonymous GitHub API returns 200; the website's actual asset selector chooses both desktop installers. Full anonymous public downloads of both installers pass the published SHA256SUMS. Mac was downloaded through sixteen verified HTTP Content-Range parts and checked after concatenation.

- Windows x64 SHA256: f58c495a7becda7a7db31f79d8fa060077acd55356ab487964c853640d19728a.
- macOS arm64 SHA256: 485fe88a5c9de05cb1cd303eb972daeb4934824f096d8991a726fe38e4ad025d.

Android/iOS physical camera, Keystore, avatar/computer menu, real OS desktop control and existing-user service upgrades remain unverified. QMD refreshed: update + embed + targeted get verified.
