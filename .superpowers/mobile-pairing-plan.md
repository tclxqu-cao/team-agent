# Mobile pairing and shared console implementation plan

Goal: Desktop exposes the CLI-compatible one-use QR invitation. Android/iOS start with the existing boot animation and a disabled console, then show the shared Web console after scanning and remember the computer in the avatar menu.

Architecture: Keep credentials in native secure storage. Bundle the existing console presentation in Vite, adapting only origin, iframe paths, native scanning and authenticated HTTP/WebSocket transport. Unpaired presentation never starts a gateway or accesses remote data.

Constraints: Preserve existing dirty work. No commits, service restarts or release publishing. No project docs changes. Keep invitation and device credentials out of logs, URLs (except the existing one-use QR fragment), and ordinary storage.

- [x] Add desktop pairing IPC, private invitation generation, QR dialog and top-right phone action.
- [x] Reuse the boot surface and console styles; add disconnected presentation with scan replacing avatar and blocked-action guidance.
- [x] Bundle shared Web console for native; adapt frames, HTTP, nonce-based WebSocket authentication and computer switching.
- [x] Persist scanned endpoints in the native directory, preserve per-origin secure credentials, recover revoked/offline connections.
- [x] Audit and repair fresh desktop installation: bundle/bootstrap terminal, Codex and remote desktop dependencies; detect optional agents and disable missing ones.
- [x] Run targeted transport/security/UI tests, WebApp and desktop builds, available Android/iOS build checks and browser verification.
- [x] Review scoped diff, record reusable findings in wiki, report evidence and remaining device checks.

Validation evidence: 108 targeted tests passed. Desktop renderer/WebApp/bootstrap builds and desktop TypeScript compilation passed. macOS unsigned app packaging and iOS simulator build passed. Native preview capabilities preserve Range streaming, are scoped to document resources, expire absolutely and stop after device revocation/lock. Runtime manifests require nativeConsole capability v1 so incompatible older runtime packages cannot be accepted. Existing WebApp typecheck errors were reproduced from HEAD source; five wider Web console source-contract assertions already differ from HEAD behavior.

Release boundary: no services restarted, no commits/push/npm/App Store release. CLI/runtime packages must be published with a new version containing these changes before distributing the matching desktop/mobile builds. Physical phone scanning, OS permissions, Codex account authorization and a fresh machine install remain acceptance checks.

Final native checks: Android debug APK and iOS simulator App both contain byte-matching final WebApp assets. SDK35 android.jar restored from an official SDK-manager download; Android built with a checksummed temporary Temurin JDK21. macOS packaged bootstrap SHA256 matches the built worker, and ASAR contains pairing/main/bootstrap/QR vendor files.
