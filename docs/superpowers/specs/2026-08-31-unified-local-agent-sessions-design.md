---
title: Unified Local Agent Sessions
date: 2026-08-31
status: approved
---

# Unified Local Agent Sessions

## Goal

Customer Agent becomes the local control surface for three peer runtimes:

- Customer Agent
- Codex
- Claude Code

The desktop app discovers existing local sessions directly from their native stores, labels every session by runtime, renders native history, and continues an idle native session through its owning runtime. It does not import or duplicate Codex or Claude Code history into Customer Agent's SQLite database.

The first release covers this Mac only. Cloud tasks, remote hosts, and cross-device synchronization are out of scope.

## Product Contract

1. The session list includes local sessions from all three runtimes.
2. A session identity is the pair `(agentType, nativeSessionId)`.
3. Existing native history remains authoritative and is read on demand.
4. New-session creation requires an explicit runtime selection, defaulting to Customer Agent.
5. Sending a message continues the selected session with its original runtime and working directory.
6. A session owned by another running client is read-only. Customer Agent may resume it only after the original client releases it.
7. Runtime failures are isolated. A missing or unhealthy Codex or Claude Code installation does not hide Customer Agent sessions or crash the desktop app.
8. Deleting an external session is not supported in this release. The app only deletes Customer Agent-owned sessions.

## Architecture

### Unified domain

Add a desktop-main runtime boundary rather than extending the model-provider abstraction. A model provider only generates model responses; a runtime owns conversation persistence, tools, approvals, skills, processes, and resume semantics.

```ts
type AgentType = "customer-agent" | "codex" | "claude-code";

interface UnifiedSessionSummary {
  id: string; // encoded agentType + nativeSessionId
  agentType: AgentType;
  nativeSessionId: string;
  title: string;
  cwd: string;
  projectId?: string;
  parentSessionId?: string;
  created: string;
  updated: string;
  status: "idle" | "running" | "completed" | "failed";
  occupancy: "available" | "owned-by-customer-agent" | "owned-externally";
  sourceLabel: string;
  canResume: boolean;
  canDelete: boolean;
}

interface AgentRuntimeAdapter {
  readonly agentType: AgentType;
  discoverSessions(): Promise<UnifiedSessionSummary[]>;
  getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
  create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
  run(nativeSessionId: string, input: string): AsyncIterable<AgentEvent>;
  abort(nativeSessionId: string): Promise<void>;
}
```

`UnifiedSessionService` owns adapter registration, encoded ID parsing, aggregate sorting, project matching, occupancy checks, and runtime event routing. Renderer code calls one IPC surface and never reads native files or starts native processes directly.

### Customer Agent adapter

`CustomerAgentRuntimeAdapter` wraps the existing `SQLiteSessionStore` and `AgentHost` behavior. Existing session IDs remain valid. Its history and event conversion are lossless because they already use the shared `Message` and `AgentEvent` types.

### Codex adapter

`CodexRuntimeAdapter` owns one long-lived `codex app-server --stdio` process and a small newline-delimited JSON-RPC client.

- `thread/list` is paged until `nextCursor` is empty, so all local Codex sessions are discoverable.
- `thread/read { includeTurns: true }` supplies native history without resuming or acquiring the writer.
- `thread/start` creates a native Codex thread for the selected working directory.
- `thread/resume` followed by `turn/start` continues an available thread.
- App Server notifications are mapped to the existing `AgentEvent` stream.
- `turn/interrupt` aborts a turn started by Customer Agent.

The adapter never resumes during discovery or history viewing. External occupancy is determined from the native rollout path held open by another process and is rechecked immediately before resume. A writer-conflict response is normalized to `SESSION_OCCUPIED` and leaves the session read-only.

Codex command and file approvals are bridged into the existing user-question event channel. The adapter answers App Server server requests only after the user chooses an option. Until that bridge is available, the run must use the user's existing approval policy and fail closed instead of silently bypassing approvals.

### Claude Code adapter

`ClaudeCodeRuntimeAdapter` uses two native surfaces because the Claude Agent SDK does not list every historical local CLI session:

- Read-only discovery and history parsing scan root session JSONL files under `~/.claude/projects`. Subagent JSONL files are represented as children of their root session rather than duplicated as roots.
- Creation and continuation use `@anthropic-ai/claude-agent-sdk`, passing `cwd`, a new UUID for creation, or `resume: nativeSessionId` for continuation.

The adapter maps SDK system, assistant, result, tool, and partial streaming messages into the existing event model. It uses an abort controller for turns started by Customer Agent.

Occupancy combines `claude agents --json --all` with open-file ownership for foreground CLI sessions. A session reported active or held open by another Claude process is read-only. Occupancy is rechecked immediately before `resume`.

SDK permission callbacks are bridged into the existing user-question event channel. No permission-bypass flag is introduced by this feature.

## Native History Mapping

History conversion is deliberately presentation-only:

- Native user text becomes a user chat message.
- Native assistant text becomes an assistant chat message.
- Tool calls and tool results become existing tool cards when the native record contains stable tool IDs.
- Reasoning is not persisted into Customer Agent storage and is not exposed unless the native protocol marks it as user-visible summary text.
- Unsupported native record types are skipped, not coerced into chat text.
- Malformed trailing JSONL caused by an active writer is ignored until the next refresh.

The selected session is refreshed when its native file changes. Session discovery is refreshed at startup, on explicit refresh, after a native run, and on a modest polling interval while the window is visible.

## Project Association

Native `cwd` is matched to the most specific registered Customer Agent project path. Sessions whose path is not registered appear under a synthetic `Other local sessions` group. Discovery never creates projects automatically.

New native sessions require a selected project because Codex and Claude Code need an explicit working directory. Customer Agent sessions retain the existing project-optional behavior for voice and generic conversations.

## Desktop UX

The sidebar remains project-first. Each session row gains a compact runtime mark and an occupancy indicator:

- Customer Agent: `CA`
- Codex: `CX`
- Claude Code: `CC`
- occupied: lock icon and `Read-only` tooltip

The new-session button opens a small runtime menu with the three runtime choices. Runtime availability is shown in the menu; an unavailable runtime is disabled with its diagnostic reason.

Opening an occupied session shows current native history and a quiet read-only banner above the composer. The composer is disabled until the next occupancy refresh reports that the owner released the session. There is no force-takeover action.

External sessions do not show a delete action. Customer Agent sessions keep the existing delete action.

## Event And Run Semantics

IPC run requests include the encoded unified session ID. `UnifiedSessionService` routes the request to exactly one adapter. Events keep `_sid` equal to the encoded ID, allowing the existing renderer store to route simultaneous session updates correctly.

Only one Customer Agent-owned run may write a native session at a time. Per-session run handles are kept by the owning adapter. Abort is routed to the selected adapter and does not terminate unrelated runs.

When a native process exits unexpectedly, the adapter emits a structured error followed by a terminal failed state. Partial assistant text remains visible but is not written into a different store.

## Error Handling

- Missing executable or SDK: runtime health reports unavailable; other runtimes continue working.
- Protocol/schema drift: skip malformed history records and surface a diagnostic count.
- App Server crash: reject pending requests, restart lazily on the next operation, and do not retry a turn automatically.
- External writer race: normalize to occupied, refresh the session, and preserve the user's unsent draft.
- Native authentication failure: surface the native error and keep the session resumable after authentication is repaired.
- Unknown encoded session ID: return a typed not-found error.

## Security

- Native subprocesses inherit the user's existing runtime configuration and credentials; Customer Agent does not copy tokens.
- No new bypass-permission or danger-full-access defaults are added.
- Native session paths are resolved under the expected runtime roots before reading.
- Renderer input cannot supply arbitrary executable paths or native history paths.
- External histories are read-only from Customer Agent; delete and rewrite operations are unavailable.

## Verification

Automated tests cover:

- encoded unified ID round trips and invalid IDs;
- aggregate sorting, project matching, and runtime isolation;
- Codex JSON-RPC framing, pagination, history mapping, notifications, writer conflict, and restart after process failure;
- Claude root-session discovery, subagent grouping, malformed tail handling, history mapping, active-session correlation, SDK option construction, streaming event mapping, and abort;
- Customer Agent adapter compatibility with existing sessions;
- IPC routing for list, get, create, run, abort, and permission answers;
- renderer runtime labels, new-session menu, external delete suppression, and occupied composer state.

Runtime verification on this Mac must prove:

1. Existing Customer Agent, Codex Desktop/CLI, and Claude Code CLI sessions appear without copying them into Customer Agent SQLite.
2. An externally occupied Codex session and an externally occupied Claude session render read-only.
3. Releasing the original client changes the session to available and allows a native follow-up.
4. New sessions can be created for all three runtime types in the selected project.
5. A harmless follow-up in each runtime streams output into the same desktop conversation.
6. Restarting Customer Agent preserves discovery because the native stores remain authoritative.

## Rollout

This is a local desktop capability. Database migration is not required for external histories. Any optional cache stores only derived session summaries and may be rebuilt at any time.

After automated and runtime verification, rebuild the desktop package, stop only the existing Customer Agent desktop process, and launch the new build. Do not stop Codex or Claude Code processes merely to restart Customer Agent.
