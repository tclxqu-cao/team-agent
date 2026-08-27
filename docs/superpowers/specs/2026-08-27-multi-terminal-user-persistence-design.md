# Multi-Terminal User Persistence Design

**Date:** 2026-08-27
**Status:** Approved design
**Project:** customer-agent

## 1. Goal

Upgrade the remote Web console from one shared-token terminal into a single-user, password-authenticated workspace with:

- up to eight concurrent terminal tabs;
- tap and horizontal-swipe tab switching;
- browser/network disconnect recovery while the Gateway process remains alive;
- one draggable file button and one draggable shortcut-key dock;
- per-user visual preferences and per-device workspace state;
- a right drawer with Files and History tabs;
- server-side shell command history;
- strict ownership checks for terminals, filesystem access, history, and preferences.

The first release supports one administrator account. All records still carry `user_id` so multi-user isolation can be added without changing ownership semantics.

## 2. Non-Goals

- Restoring a live PTY after Gateway or Mac restart.
- Persisting OpenCode, Claude Code, Codex, or customer-agent process memory after the PTY exits.
- Recording Agent prompts or input typed inside alternate-screen TUIs.
- Public registration, password reset by email, teams, roles, or directory-level ACL management.
- Running terminals in containers or OS-level sandboxes.
- Multiple simultaneous writers to the same terminal.

## 3. Approved User Experience

### 3.1 Terminal Tabs

- The top bar displays terminal tabs and a `+` action.
- A user can keep at most eight active or detached terminals.
- Tapping a tab activates it.
- A horizontal gesture in the terminal content switches to the adjacent tab when horizontal travel exceeds 64 px and clearly dominates vertical travel.
- Vertical gestures continue to scroll normal terminal history or send PageUp/PageDown to alternate-screen TUIs.
- Long-pressing a tab opens rename.
- Tabs can be reordered. The new order is stored immediately.
- Closing a tab requires confirmation, kills the PTY, and marks the tab `closed`.
- Closing the browser or losing the network detaches terminals without killing them.

### 3.2 File and History Drawer

- A draggable `Files` floating button is always available.
- The right drawer has two tabs: `Files` and `History`.
- The Files tab retains lazy directory loading, filtering, path override, terminal cwd following, live filesystem events, and rich preview.
- The History tab searches and filters shell commands by terminal and cwd.
- Selecting a history entry can copy it or fill it into the active terminal. It never executes automatically.

### 3.3 Draggable Controls

- The file button and shortcut-key dock are independently draggable.
- The dock includes a Hide action.
- When hidden, a small draggable keyboard button restores the dock.
- Positions are stored as normalized viewport ratios plus an edge anchor, not absolute pixels.
- The mobile keyboard temporarily constrains controls to the visible `visualViewport`; keyboard-induced offsets are not persisted.
- Drag end persists immediately. Keyboard and pointer interactions must not blur xterm's hidden textarea.

The approved visual companion mockup uses top terminal tabs, a right Files/History drawer, and draggable controls above the mobile keyboard.

## 4. System Architecture

```text
Browser
  ├── POST /api/web-auth/setup|login|logout|revoke
  │      └── HttpOnly auth cookie
  ├── GET/PATCH /api/web-console/bootstrap|preferences|device-state|history
  └── WebSocket /ws (cookie + origin + connection nonce)
         ├── AuthService
         ├── TerminalHub
         ├── PreferenceService
         ├── DeviceStateService
         └── CommandHistoryService
                └── SQLite at AGENT_DATA_DIR
```

### 4.1 AuthService

Owns first-run setup, password verification, login rate limiting, auth sessions, cookie issuance, sliding expiration, logout, and revoke-all-devices.

### 4.2 TerminalHub

Replaces the global `terminals` map embedded in `ws-server.mjs` with a testable service that owns:

- PTY creation, input, resize, cwd tracking, output, exit, and kill;
- terminal ownership by `user_id`;
- attach/detach per WebSocket connection;
- per-terminal scrollback and monotonic output sequence;
- one active input lease per terminal;
- connection-local channel allocation;
- terminal metadata persistence through `TerminalRepository`.

TerminalHub continues to use `node-pty`. It does not introduce tmux because restart-level PTY recovery is out of scope.

### 4.3 ws-server.mjs

Becomes the HTTP/WebSocket composition root. It prepares Next.js, authenticates the socket, parses protocol frames, and delegates behavior. It must not own terminal lifecycle maps, user records, preferences, or command history directly.

### 4.4 Persistence Services

- `TerminalRepository`: terminal tab metadata and lifecycle status.
- `PreferenceService`: user-global visual preferences with optimistic revision.
- `DeviceStateService`: device-specific active tab and workspace state.
- `CommandHistoryService`: redacted, searchable shell command records.

The database path is resolved from `AGENT_DATA_DIR`. It must not depend on process cwd.

## 5. Data Model

### 5.1 users

```text
id                    TEXT PRIMARY KEY
username_normalized   TEXT UNIQUE NOT NULL
username_display      TEXT NOT NULL
password_hash         BLOB NOT NULL
password_salt         BLOB NOT NULL
password_version      INTEGER NOT NULL
created_at            TEXT NOT NULL
password_changed_at   TEXT NOT NULL
```

The first setup transaction succeeds only when the table is empty. Registration is unavailable after the first user is created.

### 5.2 auth_sessions

```text
id              TEXT PRIMARY KEY
user_id         TEXT NOT NULL
token_hash      BLOB UNIQUE NOT NULL
csrf_hash       BLOB NOT NULL
ws_nonce_hash   BLOB
ws_nonce_expires_at TEXT
device_id       TEXT NOT NULL
device_name     TEXT
user_agent      TEXT
created_at      TEXT NOT NULL
last_seen_at    TEXT NOT NULL
expires_at      TEXT NOT NULL
revoked_at      TEXT
```

Sessions use 30-day sliding expiration. Only a token hash is persisted.

### 5.3 terminal_tabs

```text
id                TEXT PRIMARY KEY      # stable terminalId
user_id           TEXT NOT NULL
title             TEXT NOT NULL
shell             TEXT NOT NULL
start_cwd         TEXT NOT NULL
current_cwd       TEXT NOT NULL
status            TEXT NOT NULL         # active/detached/exited/closed
sort_order        INTEGER NOT NULL
created_at        TEXT NOT NULL
last_active_at    TEXT NOT NULL
exited_at         TEXT
closed_at         TEXT
```

One active/detached row maps to one live TerminalHub PTY with the same ID. On Gateway startup, stale `active` and `detached` records are marked `exited` because no PTY survived.

### 5.4 user_preferences

```text
user_id                     TEXT PRIMARY KEY
revision                    INTEGER NOT NULL
theme                       TEXT NOT NULL
terminal_font_size          INTEGER NOT NULL
file_button_position_json   TEXT NOT NULL
keybar_position_json        TEXT NOT NULL
keybar_hidden               INTEGER NOT NULL
key_order_json              TEXT NOT NULL
updated_at                  TEXT NOT NULL
```

Positions contain normalized x/y ratios and an anchor. Updates use revision-based optimistic concurrency.

### 5.5 device_states

```text
user_id                     TEXT NOT NULL
device_id                   TEXT NOT NULL
active_terminal_id          TEXT
drawer_open                 INTEGER NOT NULL
drawer_tab                  TEXT NOT NULL       # files/history
file_tree_root              TEXT
file_tree_follow_mode       INTEGER NOT NULL
expanded_paths_json         TEXT NOT NULL
selected_file               TEXT
terminal_scroll_json        TEXT NOT NULL
updated_at                  TEXT NOT NULL
PRIMARY KEY (user_id, device_id)
```

Device state prevents a phone and desktop from continually overwriting each other's active tab, drawer, tree, and scroll position. A stable, non-secret device ID is retained across auth-session renewal so the same browser can recover state after logging in again.

### 5.6 command_history

```text
id            INTEGER PRIMARY KEY AUTOINCREMENT
user_id       TEXT NOT NULL
terminal_id   TEXT NOT NULL
command       TEXT NOT NULL
cwd           TEXT NOT NULL
executed_at   TEXT NOT NULL
```

Indexes cover `(user_id, executed_at DESC)`, `(user_id, terminal_id, executed_at DESC)`, and search over normalized command text. Retention is the newest 5,000 rows per user.

## 6. Authentication and Security

- Passwords use Node's `scrypt` with a random salt and a versioned parameter set.
- Password length is at least 10 characters.
- Username comparison uses a normalized canonical value.
- Failed login attempts are limited by IP and normalized username to five per 15 minutes.
- Browser auth uses a random opaque token in an `HttpOnly; SameSite=Strict; Path=/` cookie. HTTPS adds `Secure`.
- State-changing HTTP requests require a CSRF header.
- WebSocket upgrade verifies the auth cookie, expected Origin, and a short-lived connection nonce from bootstrap.
- `AGENT_WEB_TOKEN` is removed from the normal login flow and is never stored in localStorage.
- Every terminal, filesystem root, history record, preference, and device-state operation checks `resource.user_id === auth.user_id`.
- Active cwd expansion is scoped to the current user's terminals instead of every terminal in the process.
- API keys and password material never appear in logs, command history, browser storage, or WebSocket diagnostics.

## 7. WebSocket Protocol

### 7.1 Control Frames

JSON control frames support:

```text
connection:hello
terminal:list/create/attach/detach/rename/reorder/resize/kill/request-write
terminal:attached/exited/write-owner
preference:update
device-state:update
history:list/search/delete/clear
fs:list/read/watch/unwatch/dataurl
```

Every terminal operation includes a stable `terminalId`. The server derives user identity from the authenticated connection; clients cannot supply or override `userId`.

### 7.2 Binary Frames

```text
byte 0       protocol version
byte 1       frame type: input/output
bytes 2..5   uint32 connection-local channelId
bytes 6..N   raw PTY payload
```

On attach, the server maps `terminalId` to `channelId`. Channel IDs are valid only for the current WebSocket and can change after reconnect.

Output carries a monotonic sequence in attach/replay metadata. The client reports its last acknowledged sequence so reconnect replay does not duplicate rendered bytes.

### 7.3 Write Lease

- Multiple devices can attach and observe one terminal.
- One device owns terminal input at a time.
- Focusing the input area requests the write lease.
- A takeover is explicit when another connected device owns it.
- The lease releases 15 seconds after owner disconnect or immediately on explicit release.

## 8. Recovery and State Synchronization

### 8.1 Bootstrap

After login, `/api/web-console/bootstrap` returns:

- user display data;
- global preferences and revision;
- current device state;
- active/detached/exited terminal tabs ordered by `sort_order`;
- WebSocket connection nonce.

The browser opens one WebSocket and attaches all active/detached terminals. Only the active xterm is visible; other xterm instances retain buffers without consuming layout space.

### 8.2 Save Policy

- Drag end, tab close, terminal reorder, and terminal rename save immediately.
- Active tab, drawer state, tree state, and scroll state save with a 500 ms debounce.
- `pagehide` sends a final keepalive update.
- Keyboard-induced control clamping is visual only and does not overwrite stored positions.

### 8.3 Recovery Boundaries

- Browser close or network loss: PTYs remain active, tabs detach, and state restores after login/reconnect.
- Gateway restart: live PTYs are gone; persisted active/detached rows become exited.
- Mac restart: same as Gateway restart; no command is automatically re-executed.
- Exited terminals retain metadata in SQLite and final scrollback only while TerminalHub remains alive. This phase does not persist PTY scrollback to SQLite, and exited terminals never appear as running.

## 9. Shell Command History

Shell command history is captured through shell integration rather than reconstructing keyboard events.

- zsh uses a `preexec` hook that emits a private OSC 633 command event.
- The Gateway parses command, cwd, terminalId, and timestamp.
- Alternate-screen input is excluded.
- Secret-input mode is excluded.
- Assignments containing `token`, `password`, `secret`, or `api_key` are redacted before persistence.
- History write failures never block PTY input or shell execution.
- Users can search, filter, copy, fill without Enter, delete one record, clear one terminal, or clear all history.

## 10. Error Handling

- Auth failure returns the login screen without a reconnect loop.
- Network loss displays reconnecting state without killing terminals.
- Write lease loss makes the local terminal read-only and offers takeover.
- PTY exit updates the tab to exited and preserves final visible output.
- Terminal limit returns a typed error and directs the user to close a tab.
- Preference revision conflicts reload server state and merge the latest local gesture result.
- Missing PTY on attach marks its tab exited.
- Command-history errors are logged server-side and do not affect the terminal.
- Filesystem errors remain scoped to the relevant drawer operation.

## 11. Migration

1. Add schema migrations for all five tables without altering existing AI conversation sessions.
2. Fix the server data path through `AGENT_DATA_DIR` before creating user records.
3. On first launch with no user, expose setup. Existing `AGENT_WEB_TOKEN` does not create an account automatically.
4. Existing Web terminal localStorage token and UI state are ignored after authentication migration.
5. Existing in-memory PTYs are not migrated during deployment.
6. Existing `.sessions` files and `.next` artifacts remain outside the feature and are not imported.

## 12. Testing

### Unit

- scrypt hash/verify and password-version upgrade;
- setup race and username uniqueness;
- auth token hashing, sliding expiry, revoke, and login limiting;
- TerminalHub lifecycle, ownership, channel routing, replay sequence, and write lease;
- preference revision conflict and normalized-position clamping;
- command history redaction and retention.

### Integration

- setup/login/logout/revoke-all;
- cookie and CSRF-protected HTTP calls;
- authenticated WebSocket nonce handshake;
- eight terminals with isolated binary channels;
- attach/detach/reconnect/kill/reorder/rename;
- same-user multi-device read and write takeover;
- per-user terminal/filesystem/history isolation;
- shell history capture without alternate-buffer prompts.

### Browser E2E

- desktop and 390×844 mobile layouts;
- tapping and horizontal swiping between terminal tabs;
- vertical scrolling in normal and alternate buffers;
- keyboard-visible draggable controls;
- hide and restore shortcut dock;
- Files/History drawer switching;
- reconnect restoration of Agent process, active tab, tree, preview, and scroll state;
- login persistence and logout behavior.

## 13. Implementation Order

1. **Identity foundation:** migrations, repositories, first-user setup, login cookies, CSRF, API/WS ownership.
2. **TerminalHub:** extract PTY ownership, channel multiplexing, write lease, terminal records, replay sequence.
3. **Multi-tab UI:** bootstrap, multiple xterm instances, header tabs, click/swipe/reorder/close, reconnect restoration.
4. **Personalization and history:** draggable file button and key dock, hidden restore button, preferences/device state, Files/History drawer, shell integration.

Each phase must leave tests passing and should be reviewed before starting the next phase.
