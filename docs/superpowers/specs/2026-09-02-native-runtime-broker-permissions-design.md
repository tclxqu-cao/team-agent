# Shared Native Runtime Broker And Recoverable Approvals Design

## Goal

Make Codex and Claude Code native sessions usable from both the Web app and
AgentRoam Desktop without competing native writer locks. Each native session
must expose the existing three permission modes, default Web-created sessions
to full access, and preserve a pending approval across a Web refresh.

The design also removes the failure mode where a duplicate send clears the
visible event stream and composer draft before the native runtime reports that
the session is already busy.

## Decisions

1. AgentRoam owns one local `NativeRuntimeBroker`, rather than starting one
   Codex app-server process per session.
2. The broker owns one reusable Codex app-server connection and its native
   session registry. Web and Electron are broker clients for native actions.
3. A Web-to-AgentRoam-Desktop handoff changes the controlling UI client; it
   does not try to release the Codex writer lock. The original app-server
   request remains connected and can receive a Desktop approval response.
4. Permission mode is an AgentRoam-local, per-unified-session setting. It does
   not modify global Codex or Claude Code configuration. Missing records mean
   `full-access`, including all existing sessions and new Web-created sessions.
5. An active turn snapshots its permission mode at admission. A mode change is
   persisted immediately but applies only to the next turn. A pending high-risk
   request can therefore never become implicitly approved when the user changes
   the menu during that turn.

## Why A Shared Broker

The current Web server and Electron main process each instantiate their own
native runtime adapters. A Codex thread loaded by one app-server process can
reject the other process with an active-writer error. Running a separate
app-server per session would make a force-release possible by killing only one
child process, but it adds repeated process startup, memory use, and tool/MCP
initialization for every concurrent session.

The broker keeps the efficient single connection while treating the current
client as a logical controller. When the user opens a Web-owned session in
AgentRoam Desktop, Desktop attaches to the same broker run instead of trying to
resume the native thread through a competing app-server connection.

This does not give AgentRoam authority to take over a session held by the
official Codex Desktop or another external client. Those sessions remain
read-only and retain the existing explicit fork recovery path.

## Broker Boundary

`NativeRuntimeBroker` is a local process with a private Unix-domain socket and
a data directory controlled by `AGENT_NATIVE_RUNTIME_DIR`. The default is a
per-user directory under `~/.agentroam/native-runtime`; the directory and socket
are owner-readable/writable only. The process is started on demand and reused
by the Web server and Electron main process.

The broker owns:

- one `CodexAppServerClient` and its app-server child process;
- the Claude Code SDK runtime host;
- native-session discovery, run admission, and native request routing;
- durable session permission records;
- durable active-run snapshots, event replay, and pending approval metadata;
- the controller assignment for a Web or Desktop client.

Next.js routes and Electron IPC become thin clients of the broker for Codex and
Claude Code sessions. Customer Agent sessions retain their existing local
`AgentHost` implementation and are not moved into the broker.

### Broker Lifecycle

Web and Desktop clients acquire a renewable broker lease while they display or
control a native session. An active run, including a pending approval, pins the
broker independently of a renderer lease so a short refresh cannot terminate
the original app-server request. Once there are no live client leases and no
active native runs, the broker waits a short idle grace, disposes its app-server
child and Claude runtime resources, then removes its socket. The next client
starts a fresh broker and rehydrates only durable terminal/policy state.

This prevents an orphaned AgentRoam process from retaining idle native threads
when no AgentRoam surface is using them. The broker must not exit while any
other Web or Desktop session has a live turn; a shared app-server cannot safely
force-unload only one such loaded thread.

The broker uses a small SQLite database because it is the sole writer and can
atomically store admission, event sequence numbers, approval state, and terminal
cleanup. It has these logical records:

| Record | Key | Required data |
| --- | --- | --- |
| `native_session_policy` | unified session id | permission mode, updated timestamp |
| `native_run` | unified session id | run id, agent type, native id, turn id, status, controller, mode snapshot, timestamps |
| `native_run_event` | run id plus sequence | replayable agent event and sequence number |
| `native_approval` | broker question id | run id, original RPC request id, protocol method, request payload needed to render/respond, state |
| `native_terminal` | unified session id | terminal reason and one replayable terminal event retained for reconnecting clients |

The database is an implementation detail of the broker. No renderer, Next.js
route, or Electron renderer reads it directly.

## Permission Contract

The menu uses the existing `ToolPermissionMode` values and is visible for all
three runtime types.

| Menu value | User-facing behavior | Codex turn configuration | Claude SDK configuration |
| --- | --- | --- | --- |
| `request-approval` | Request approval before operations that exceed the conservative read-only policy. | `approvalPolicy: "onRequest"` and `sandboxPolicy: { type: "readOnly" }`. Escalation is represented by a real approval request. | `permissionMode: "default"` with the broker approval callback enabled. |
| `auto-approval` | Allow known safe and workspace-scoped work; request approval for external writes, risky shell commands, network writes, remote side effects, and unknown tools. | `approvalPolicy: "onRequest"` and `sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }`. | `permissionMode: "default"` with the adapter-specific classifier and approval callback enabled. |
| `full-access` | Do not show AgentRoam approval cards for that turn. | `approvalPolicy: "never"` and `sandboxPolicy: { type: "dangerFullAccess" }`. | `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, and no custom approval callback. |

The Codex values above use the current App Server names, including `onRequest`,
`readOnly`, `workspaceWrite`, and `dangerFullAccess`.

For Claude, the broker normalizes native tool names and inputs into the existing
core permission classification model. The adapter must not classify an unknown
or malformed tool request as safe. It becomes an approval request in both
approval modes.

`full-access` is intentionally explicit. It is the default requested by the
user for Web-created native sessions, but a user can change the setting on a
per-session basis before a later turn starts.

## Run Admission And Event Ownership

`POST /api/agent/run` must reserve a native run synchronously before it returns
success or clears any stream state. The broker admission transaction performs:

1. Look up the unified native session id and any existing `native_run` row.
2. If a live run exists, return `SESSION_OCCUPIED` with HTTP 409. Do not alter
   the prior event log, pending approval, controller, or caller draft.
3. If a stale broker row exists, write a terminal interruption event, remove its
   pending approvals and lock, then continue with a new admission.
4. Create a run id, snapshot the selected permission mode, record the initial
   controller, and persist an empty sequence before starting the adapter turn.
5. Return the stream endpoint only after this reservation succeeds.

The native adapter appends each generated event through the broker. Sequence
numbers are scoped to the run, not merely the session, and every `ask_user`
event has a stable broker question id:

```
native:<run-id>:<original-request-id>
```

The UI keeps its optimistic user message until admission succeeds. A 409 leaves
that draft in place and presents the occupied/fork recovery without clearing
the event history of the active turn.

## Refresh And Approval Recovery

`GET /api/sessions/:id` for a native session returns the stored active-run
snapshot in addition to native history. The snapshot includes nonterminal
events and unresolved `ask_user` cards for the active run. The SSE endpoint
also replays the same snapshot to a fresh native-session subscriber; a
`Last-Event-ID` subscriber receives only later sequence numbers.

`ChatView` deduplicates recovered events by run id plus sequence number and
deduplicates approval cards by question id. A refresh therefore shows the same
card, not a second card, and keeps the original question id needed by the
answer route.

`POST /api/agent/answer` first resolves the question through the broker. It
validates that the approval belongs to a currently active run, claims it once,
and sends the response on the original adapter/client connection. A repeated
answer receives an explicit expired-or-resolved result; it never replaces the
stored event sequence or silently answers a later request.

Supported Codex server requests include:

- `item/tool/requestUserInput`;
- `item/commandExecution/requestApproval`;
- `item/fileChange/requestApproval`;
- legacy `applyPatchApproval` and `execCommandApproval` where emitted by an
  older app-server;
- v2 `item/permissions/requestApproval`.

The v2 permission request card renders the requested filesystem and network
scope. An allow-once answer returns only the requested permission subset with
turn scope; an allow-session answer returns only that subset with session scope.
Decline and cancel do not grant a broader permission. Unrecognized server
requests are responded to with a protocol error, recorded as an actionable
terminal error, and cannot remain as an invisible pending request.

## Cleanup Rules

Cleanup is idempotent and is scoped to one native run. It never clears locks or
approvals belonging to another Web or Desktop session.

- `serverRequest/resolved` marks and removes only the matching approval row and
  its pending card. The run lock remains because the turn may continue to emit
  tools or request another approval.
- `turn/completed` finalizes the run, removes all remaining approval rows,
  clears that session's run lock, records a terminal event, and invalidates
  cached native detail.
- A user interrupt calls the adapter interruption API. The broker finalizes on
  the corresponding terminal completion; a bounded fallback finalizes it as
  interrupted if the native runtime cannot emit completion.
- An app-server exit or Claude runtime host failure writes a clear terminal
  interruption event such as "Native runtime restarted; this turn was
  interrupted. You can send again.", clears only affected session locks and
  approvals, and retains the terminal event for reconnecting clients.
- On broker startup, any row that was active under a prior broker instance is
  converted to the same terminal interruption state before it accepts a new
  turn. The old app-server request cannot be resumed after its process exited,
  so the system must report that fact rather than render a nonfunctional card.

## Controller Handoff

`POST /api/sessions/:id/handoff` moves the broker controller from Web to
AgentRoam Desktop. Electron invokes the broker client, subscribes to the same
run/event sequence, and renders the same pending approval card if one exists.
The Web client stops rendering controls for that run after it receives the
handoff event.

Handoff does not interrupt a turn, start another turn, release a Codex writer
lock, or change the permission-mode snapshot. It only changes which AgentRoam
surface may submit an answer, steer, abort, or later send.

For an externally owned Codex Desktop session, AgentRoam still cannot force a
handoff or release its writer lock. `thread/unsubscribe` only removes the
current connection's subscription and App Server may retain the loaded thread
for a no-subscriber grace period. The existing persisted fork flow remains the
immediate safe continuation option for that case.

## UI And Transport Changes

- Native session summaries and details expose the persisted `permissionMode`.
- `PATCH /api/sessions/:id` and Electron `sessions:setPermissionMode` accept
  native sessions and delegate to the broker instead of returning 405.
- `ChatView` no longer hides the three-level permission menu for native
  sessions. Its selected value comes from the session policy. The mode is
  disabled only while the requested change is being saved; active turns retain
  their admission-time mode snapshot.
- Native event delivery carries run id and sequence metadata internally so Web
  and Desktop can resume reliably. Existing renderer event consumers may ignore
  the metadata after deduplication.
- Web gateway and Electron preload expose broker-backed get, run, answer,
  abort, steer, permission update, and handoff operations under the existing
  runtime/session abstractions where possible.

## Migration And Compatibility

No existing native session is rewritten. A missing policy record resolves to
`full-access`, preserving the requested default and making rollout backwards
compatible. Existing stored Customer Agent `permissionMode` metadata remains
unchanged.

The broker supports legacy Codex approval methods and the v2 permission request
method concurrently. Older app-server versions that do not emit v2 requests
continue to render their existing approval cards.

## Verification

Focused automated coverage must prove:

1. Native sessions with no policy record, including newly Web-created ones,
   resolve to `full-access`; updates persist and are visible from both Web and
   Electron broker clients.
2. Codex `turn/start` receives the exact three permission-policy mappings;
   Claude receives the corresponding SDK options and no callback in full access.
3. The Claude classifier never auto-allows a risky or unknown operation.
4. Native run admission returns 409 before event reset and preserves the prior
   events plus the caller's unsent draft.
5. A page refresh rehydrates one unresolved approval card with the original
   question id; answering it sends one response to the original app-server
   request and duplicate answers fail safely.
6. Legacy command/file requests and v2 `item/permissions/requestApproval`
   generate the correct card and response payload.
7. `serverRequest/resolved` removes only one card while retaining the run lock;
   each terminal path clears only its own run lock and pending approvals.
8. Broker restart and app-server exit emit a user-visible interruption and
   unlock only their affected sessions.
9. Web-to-Desktop handoff preserves a live turn and a pending approval without
   creating a second app-server client or affecting another active Web session.
10. Existing external-ownership and fork behavior remains intact.

Run the focused core, native adapter, broker, server route, Web gateway,
Electron IPC/preload, and shared renderer tests; then run the affected type
checks and a real two-surface acceptance test with a pending Codex approval.

## Non-Goals

- Changing global Codex, Claude Code, or OS permission settings.
- Automatically approving privileged commands, network access, or external
  writes in either approval mode.
- Taking over a thread owned by official Codex Desktop or another external
  client.
- Promise an immediate per-thread unload from a shared app-server process for
  an external client. App Server does not offer that guarantee.
- Moving Customer Agent sessions into the native runtime broker.
