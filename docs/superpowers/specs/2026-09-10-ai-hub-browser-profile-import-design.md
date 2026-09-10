# AI Hub Browser Profile Import Design

## Context

AI Hub currently renders each provider in an Electron `WebContentsView` backed by a separate persistent partition. Google blocks interactive sign-in from embedded Electron surfaces, and authentication completed in Chrome or ego-lite does not propagate into those partitions. The user wants to import an existing browser Profile once and then continue using ChatGPT, Gemini, Grok, and DeepSeek inside AI Hub.

Chrome and ego-lite both keep a Chromium `Default` Profile on this macOS host, but they use different Keychain entries for encrypted cookies:

- Chrome: `Chrome Safe Storage`
- ego-lite: `ego safe storage`

Their browser versions are newer than Electron 44's Chromium runtime. AI Hub therefore must not open the source Profile in place or overwrite Customer Agent's normal Electron data directory.

## Decision

Add an explicit, macOS-only whole-Profile import flow for Chrome and ego-lite. The importer creates a private AI Hub snapshot under Customer Agent's `userData` directory, converts encrypted source cookies into Electron-managed cookies, and switches every AI Hub pane to one shared imported `Session` after the desktop app restarts.

"Whole Profile" means the source Profile's durable browser data is copied, including Cookies, Local Storage, IndexedDB, Service Worker data, Preferences, Web Data, History, and other persistent stores. Runtime locks, crash data, generated code caches, GPU caches, shader caches, and other reproducible caches are excluded. Extensions and saved passwords may be copied as Profile data, but AI Hub does not promise to load extensions or make saved passwords usable across browser products.

The source Profile is read-only. Import never edits Chrome or ego-lite data.

## User Experience

The AI Hub site picker contains an `Import browser profile` command. Selecting it opens a compact import panel with these detected sources:

- Google Chrome - Default
- ego-lite - Default

Unavailable sources are shown disabled with a short reason. Only sources found on disk are offered; no arbitrary filesystem picker is included in this phase.

Before import, the panel explains that the Profile can include browsing history, form data, site storage, and login sessions. The user must explicitly confirm the selected source. If its browser process is still running, import stops and asks the user to quit that browser first.

During import, the command is disabled and shows progress by phase: checking, copying, importing cookies, validating, and complete. Completion displays the source, import time, copied size, imported cookie count, skipped cookie count, and a `Restart desktop app` command. The app does not restart without a user action.

After restart, all AI Hub panes share the imported Profile. A successful existing Google session should open Gemini without entering credentials. If Google later expires or rejects the imported session, AI Hub blocks embedded Google sign-in and starts a managed real-Chrome reauthentication window. A successful login automatically synchronizes the refreshed cookies into the active shared Session and reloads the original pane without restarting Customer Agent.

The import panel also supports replacing the current imported snapshot. Re-import requires a desktop restart before copying because Electron caches a `Session` by absolute path for the life of the process.

## Architecture

### Profile Discovery

`browser-profile-source.ts` owns source definitions and process detection. It returns sanitized metadata only:

```ts
type BrowserProfileSourceId = "chrome-default" | "ego-lite-default";

interface BrowserProfileSource {
  id: BrowserProfileSourceId;
  browserName: string;
  profileName: "Default";
  profilePath: string;
  keychainService: "Chrome Safe Storage" | "ego safe storage";
  available: boolean;
  running: boolean;
  sizeBytes?: number;
  reason?: string;
}
```

Discovery is macOS-only and uses fixed paths under the current user's `Library/Application Support`. Renderer input never supplies a source path or Keychain service name.

### Atomic Profile Copy

`browser-profile-importer.ts` owns the import transaction. Its destination is:

```text
<userData>/ai-hub-browser-profile/current
```

It copies into a sibling staging directory created with mode `0700`. The copy excludes transient lock and cache paths through an explicit allow/deny policy. It never follows symbolic links outside the source Profile. Destination files remain private to the current user.

The importer validates that the staging directory contains structurally valid Profile storage before activation. Activation renames `current` to a single recoverable backup, renames staging to `current`, and only then writes import metadata. Failure removes staging and restores the previous `current`; source data is untouched.

### Cookie Migration

The source `Cookies` SQLite database is opened read-only from the copied staging snapshot, never from the live browser directory. The importer obtains the selected browser's Safe Storage secret from macOS Keychain in the main process, decrypts Chromium `v10` cookie values locally, and immediately converts them to Electron `CookiesSetDetails` records.

Before the imported `Session` is first opened, the copied source cookie database is removed from staging so Electron cannot attempt to read ciphertext encrypted for another product. Decrypted cookies are installed through `session.cookies.set`; Electron then persists them using its own encryption. Cookie plaintext, names, values, and Keychain secrets never cross IPC and are never logged or written to import metadata.

Expired, malformed, unsupported partitioned, or undecryptable cookies are skipped and counted. A cookie failure does not expose its value or abort other cookies. Import fails closed when Keychain access is denied or no cookie can be migrated from a Profile that contains encrypted cookies.

### Shared AI Hub Session

`AIHubManager` receives an optional absolute imported Profile path. Without a completed import, it preserves the existing `persist:aihub-<siteId>` partitions. With a completed import, every `WebContentsView` uses one `session.fromPath(importedProfilePath)` instance supplied through `webPreferences.session`.

Sharing one imported session is intentional: the imported Profile represents one browser identity, and provider login cookies may span several related domains. Site view lifecycle, first-load bounds retention, Google navigation interception, broadcast behavior, and the one-to-four pane layout remain unchanged.

### Managed Chrome Reauthentication

Ordinary `shell.openExternal` cannot support automatic synchronization because Customer Agent cannot observe login completion or read the resulting cookies. Google reauthentication therefore uses a managed instance of the installed Google Chrome executable, not the user's normal Chrome process.

When an AI Hub pane navigates to `https://accounts.google.com`, the main process prevents the embedded navigation and starts Chrome with:

- a new private temporary `user-data-dir` owned by the current user;
- an ephemeral loopback DevTools port selected by Chrome;
- the provider's configured home URL as the initial page;
- first-run and default-browser prompts disabled.

The temporary Profile is intentionally fresh. It is not the imported Profile and is never shared concurrently with Electron, so the user's normal Chrome can remain open and no active SQLite or LevelDB store is copied.

`chrome-reauth-session.ts` owns the child process and CDP lifecycle. It reads Chrome's generated `DevToolsActivePort`, attaches only through `127.0.0.1`, observes top-level navigation, and recognizes success only after the page leaves Google Accounts and returns to the expected provider origin. The provider origin comes from the trusted AI Hub site configuration, not from renderer-supplied callback data.

After the success redirect stabilizes, the main process retrieves cookies for Google and the target provider through CDP, converts them to Electron cookie records, writes them directly to the active shared AI Hub `Session`, and calls `session.cookies.flushStore()`. Cookie values remain in the main process. AI Hub then closes the managed Chrome window, removes its temporary Profile, reloads the originating pane, and reports `login synchronized`.

Only one managed reauthentication can run at a time. Closing the Chrome window before success returns a canceled result. A bounded timeout closes the child process and removes the temporary Profile. While Chrome is open, AI Hub exposes a `Sync and return` fallback action for cases where automatic redirect detection does not settle; it still validates that the current Chrome page is on the expected provider origin before reading cookies.

The managed flow does not attach to the user's default Chrome Profile, copy cookies from a running browser, expose a stable remote-debugging port, or disable Chrome security features. Failure leaves the current AI Hub Session unchanged.

### IPC Boundary

The preload exposes only typed operations and sanitized results:

```ts
hubListProfileSources(): Promise<BrowserProfileSourceView[]>;
hubImportProfile(sourceId: BrowserProfileSourceId): Promise<BrowserProfileImportResult>;
hubGetProfileImportStatus(): Promise<BrowserProfileImportStatus>;
hubRestartAfterProfileImport(): Promise<void>;
hubStartGoogleReauth(siteId: string): Promise<GoogleReauthResult>;
hubCancelGoogleReauth(): Promise<void>;
```

The main process validates `sourceId` against its fixed source registry. No API accepts a filesystem path, cookie payload, command, or Keychain identifier from the renderer.

## Import State And Recovery

`<userData>/ai-hub-profile-import.json` stores schema version, sanitized source ID, completion timestamp, destination path, byte count, cookie counts, and whether restart is required. It stores no browsing data or secrets.

Only one import runs at a time. Closing the window does not cancel an active copy. App shutdown waits for the current file operation to finish or leaves the staging directory inactive; the next startup removes abandoned staging directories before serving AI Hub.

The previous imported snapshot is retained until the new snapshot has been loaded successfully after restart. A startup validation failure rolls back to that backup and reports a recoverable error in the import panel.

## Security And Privacy

- Import is explicit and local; it never runs automatically on startup.
- The confirmation names the data categories included in a whole Profile copy.
- Source browsers must be closed so SQLite and LevelDB stores are consistent.
- Source directories are read-only and never opened as live Electron sessions.
- Imported data and staging directories use current-user-only permissions.
- Renderer code receives metadata and counts only.
- Logs contain phase, source ID, durations, counts, and error categories, never cookie or Keychain material.
- Existing browser-fingerprint spoofing remains removed.
- Google embedded-login interception remains active when imported authentication is absent or expired; reauthentication uses installed Chrome rather than impersonating it.
- Managed Chrome binds DevTools to loopback with an ephemeral port and deletes the temporary Profile after completion, cancellation, timeout, and next-startup orphan cleanup.
- CDP responses containing cookies are retained only long enough to write them into the Electron Session and are never returned through IPC.

## Error Handling

The UI distinguishes these stable categories:

- source unavailable
- source browser still running
- Keychain permission denied
- unsupported or corrupt Profile
- insufficient disk space
- copy failed
- cookie migration failed
- validation failed
- restart required
- Chrome unavailable
- Chrome login canceled
- Chrome login timed out
- login callback origin mismatch
- cookie synchronization failed

Errors preserve the currently active imported snapshot. Partial staging data is never selected as the live AI Hub session.

## Testing

Unit tests cover source discovery, fixed-path validation, process detection, excluded transient paths, symlink rejection, cookie timestamp and SameSite conversion, Chromium `v10` decryption fixtures, redacted errors, atomic swap, rollback, and import metadata normalization.

Manager tests verify that all panes share `session.fromPath` only after a completed import and otherwise retain per-site partitions. IPC tests reject unknown source IDs and prove that renderer-visible results contain no cookie fields or Keychain values.

Managed-login tests use a fake Chrome child and CDP endpoint to verify ephemeral port discovery, expected-origin validation, success detection, cancellation, timeout, cookie filtering, live Electron cookie writes, `flushStore`, pane reload, cleanup, single-flight behavior, and complete secret redaction.

Integration validation uses disposable fixture Profiles first. Real-machine acceptance then verifies, with explicit user confirmation:

1. Chrome import is blocked while Chrome is running.
2. Chrome import completes after Chrome is quit and requires restart.
3. After restart, ChatGPT, Gemini, Grok, and DeepSeek load inside AI Hub without the manual refresh regression.
4. Sites with valid source sessions remain logged in; expired Google sessions use the managed Chrome reauthentication flow.
5. ego-lite import follows the same flow with its own Keychain service.
6. Re-import failure leaves the previous AI Hub Profile usable.
7. Expiring the imported Google session opens a real managed Chrome window; successful Google login returns to the provider, automatically closes Chrome, refreshes the pane, and restores internal access without restarting Customer Agent.
8. Canceling or timing out the Chrome login preserves the previous AI Hub Session and removes the temporary Profile.
9. Logs, IPC payloads, and metadata contain no cookie values or secrets.

## Scope

This phase supports macOS, the detected `Default` Profile for Chrome and ego-lite, one active imported snapshot, one shared AI Hub browser identity, and on-demand Google reauthentication through an installed Google Chrome. Multiple named browser Profiles, Windows/Linux import, extension loading, password-manager migration, Chrome Sync, background periodic synchronization, attaching to a user's running default Chrome Profile, and importing while the source browser is running are out of scope.
