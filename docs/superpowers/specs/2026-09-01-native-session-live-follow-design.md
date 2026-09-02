# Native Session Live Follow Design

## Goal

When a Codex or Claude Code session is running outside AgentRoam, keep the selected conversation current without taking ownership of the native session.

## Design

- Runtime adapters expose an internal, read-only transcript watch path for a native session.
- The server owns a reference-counted file monitor keyed by unified session ID. It watches only the selected transcript file and debounces filesystem bursts.
- `GET /api/sessions/:id/changes` exposes an SSE stream containing a small `session_history_changed` revision signal. It never streams transcript contents.
- The Web gateway exposes `observeSession(id, callback)` and hides EventSource lifecycle details from shared renderer code.
- `ChatView` observes only the selected external running session. A change signal reloads the newest bounded history page without clearing the current UI.
- Refreshed history replaces the overlapping tail while preserving older pages already loaded by the user.
- If observation is unavailable or fails, the visible page polls every two seconds. Observation stops when the session changes, becomes ineligible, or the document is hidden.

## Safety

- Codex paths must resolve under `~/.codex/sessions` and come from `thread/read`.
- Claude session IDs must be safe basenames; only direct project transcript files named `<session-id>.jsonl` are considered, excluding subagent transcripts.
- File changes are only signals. Existing history parsers remain responsible for ignoring incomplete trailing JSONL records.
- The public session API does not expose native filesystem paths.

## Verification

- Unit-test watcher reuse, debounce, cleanup, and missing paths.
- Unit-test runtime watch-path resolution and SSE cleanup.
- Unit-test Web observation lifecycle and history-tail merging.
- Run focused adapter, service, gateway, renderer, and server tests plus relevant type checks.
