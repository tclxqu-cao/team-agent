# Unified Local Agent Sessions Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop app discover, display, create, and continue local Customer Agent, Codex, and Claude Code sessions through their native runtimes.

**Architecture:** Add a desktop-main runtime adapter layer behind one `UnifiedSessionService`. Customer Agent wraps the existing host/store, Codex uses a long-lived App Server JSON-RPC client, and Claude Code reads its native JSONL index while executing through the Claude Agent SDK. Renderer IPC uses encoded unified IDs and keeps native external history read-only.

**Tech Stack:** TypeScript, Electron IPC, React 18, Codex App Server JSON-RPC, `@anthropic-ai/claude-agent-sdk`, Node child processes, Vitest.

## Global Constraints

- Supported runtimes are exactly `customer-agent`, `codex`, and `claude-code`.
- Scope is local sessions on this Mac; cloud and remote sessions are excluded.
- Native history is authoritative and is not copied into Customer Agent SQLite.
- Externally occupied sessions are read-only and have no force-takeover action.
- External Codex and Claude Code sessions cannot be deleted from Customer Agent.
- No permission-bypass or danger-full-access default may be introduced.
- Runtime failure must not prevent healthy runtimes from listing or running.

---

### Task 1: Unified Runtime Contracts And IDs

**Files:**
- Create: `packages/desktop/main/agent-runtime/types.ts`
- Create: `packages/desktop/main/agent-runtime/session-id.ts`
- Unit tests: `packages/desktop/main/agent-runtime/session-id.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` and `Message` from `@agent/core`.
- Produces: `AgentType`, `UnifiedSessionSummary`, `UnifiedSessionDetail`, `RuntimeHealth`, `AgentRuntimeAdapter`, `encodeUnifiedSessionId()`, and `decodeUnifiedSessionId()`.

- [ ] **Step 1: Define the runtime contracts**

```ts
export type AgentType = "customer-agent" | "codex" | "claude-code";
export type SessionOccupancy = "available" | "owned-by-customer-agent" | "owned-externally";

export interface UnifiedSessionSummary {
  id: string;
  agentType: AgentType;
  nativeSessionId: string;
  title: string;
  cwd: string;
  projectId?: string;
  parentSessionId?: string;
  created: string;
  updated: string;
  status: "idle" | "running" | "completed" | "failed";
  occupancy: SessionOccupancy;
  sourceLabel: string;
  canResume: boolean;
  canDelete: boolean;
}
```

- [ ] **Step 2: Implement stable encoded IDs**

Use URL-safe base64 for the native ID and the wire format `runtime:<agentType>:<encodedNativeId>`. Preserve legacy Customer Agent UUIDs by decoding unprefixed IDs as `customer-agent`.

```ts
export function encodeUnifiedSessionId(agentType: AgentType, nativeSessionId: string): string;
export function decodeUnifiedSessionId(id: string): { agentType: AgentType; nativeSessionId: string };
```

- [ ] **Step 3: Add focused unit tests**

Cover all three runtime round trips, Unicode/native punctuation, legacy UUID fallback, unknown runtime, empty ID, and malformed base64.

### Task 2: Codex App Server Client And Adapter

**Files:**
- Create: `packages/desktop/main/agent-runtime/codex-app-server-client.ts`
- Create: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-app-server-client.test.ts`
- Unit tests: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: unified runtime contracts from Task 1 and the installed `codex` executable.
- Produces: `CodexAppServerClient` and `CodexRuntimeAdapter` implementing `AgentRuntimeAdapter`.

- [ ] **Step 1: Implement newline-delimited JSON-RPC lifecycle**

`CodexAppServerClient` starts `codex app-server --stdio`, sends `initialize`, sends `initialized`, correlates numeric request IDs, publishes notifications, responds to server requests, and rejects pending requests if the process exits.

```ts
request<T>(method: string, params: unknown): Promise<T>;
onNotification(listener: (message: RpcNotification) => void): () => void;
onServerRequest(listener: (message: RpcServerRequest) => void): () => void;
restart(): Promise<void>;
dispose(): Promise<void>;
```

- [ ] **Step 2: Implement complete session discovery**

Call `thread/list` with `sortKey: "updated_at"`, following `nextCursor` until empty. Map title from `name || preview`, source from the native `source`, and `cwd`, timestamps, parent ID, and rollout `path` from the response. Determine external ownership by matching open rollout files reported by `lsof` to native paths.

- [ ] **Step 3: Implement read-only native history**

Call `thread/read { threadId, includeTurns: true }`. Convert user input items, agent messages, command executions, file changes, and MCP calls into existing `Message` shapes without writing them to SQLite.

- [ ] **Step 4: Implement create, resume, run, and abort**

Use `thread/start { cwd, threadSource: { type: "app", name: "customer-agent" } }` for creation. Recheck occupancy, call `thread/resume`, then `turn/start` with text input. Map delta/item/turn notifications to `AgentEvent`; retain the active turn ID for `turn/interrupt`.

- [ ] **Step 5: Bridge approvals without bypassing policy**

Expose a pending runtime-question callback for App Server command/file approval requests. A run waits for the existing renderer answer path and replies to the App Server request with only the selected documented decision.

- [ ] **Step 6: Add focused unit tests**

Use a fake spawned process to cover fragmented JSON lines, request correlation, pagination, malformed messages, process exit, restart, history mapping, notification mapping, approval response, occupied-before-resume, and abort.

### Task 3: Claude Code Discovery And Runtime Adapter

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `bun.lock`
- Create: `packages/desktop/main/agent-runtime/claude-history.ts`
- Create: `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Unit tests: `packages/desktop/main/agent-runtime/claude-history.test.ts`
- Unit tests: `packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: unified runtime contracts from Task 1, `@anthropic-ai/claude-agent-sdk`, `~/.claude/projects`, and `claude agents --json --all`.
- Produces: `discoverClaudeSessions()`, `readClaudeSession()`, and `ClaudeRuntimeAdapter`.

- [ ] **Step 1: Add the official Claude Agent SDK dependency**

Add `@anthropic-ai/claude-agent-sdk` to the desktop package and update the lockfile through Bun.

- [ ] **Step 2: Parse native Claude root histories**

Walk only root JSONL files under project directories, excluding `subagents/` from root discovery. Read lines defensively, tolerate an incomplete final line, derive session ID/cwd/timestamps/title, and map user/assistant text plus tool use/result blocks into `Message` values.

- [ ] **Step 3: Correlate occupancy**

Parse `claude agents --json --all` for interactive/background active sessions and combine it with `lsof` results for foreground session JSONL files. Only another process makes the session `owned-externally`; runs started by this adapter are `owned-by-customer-agent`.

- [ ] **Step 4: Execute native sessions through the SDK**

Call `query()` with `cwd`, `resume` for existing sessions, or a generated `sessionId` for new sessions. Preserve user settings and permission behavior, provide an abort controller, map SDK streaming messages to `AgentEvent`, and capture the actual session ID from the SDK init message.

- [ ] **Step 5: Bridge SDK permission questions**

Implement `canUseTool` by emitting the existing ask-user contract and resolving the callback from the unified answer route. Do not use `bypassPermissions`.

- [ ] **Step 6: Add focused unit tests**

Cover root/subagent filtering, project-path decoding, malformed tail handling, title extraction, history mapping, background and open-file occupancy, creation/resume option construction, SDK event mapping, permission decisions, abort, and SDK failure.

### Task 4: Customer Agent Adapter And Unified Session Service

**Files:**
- Create: `packages/desktop/main/agent-runtime/customer-agent-runtime-adapter.ts`
- Create: `packages/desktop/main/agent-runtime/unified-session-service.ts`
- Create: `packages/desktop/main/agent-runtime/index.ts`
- Unit tests: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`
- Modify: `packages/desktop/main/agent-host.ts`
- Modify: `packages/desktop/main/index.ts`

**Interfaces:**
- Consumes: all adapters, `AgentHost`, `SQLiteSessionStore`, and `ProjectStore`.
- Produces: `UnifiedSessionService.list/get/create/run/abort/answerQuestion/delete`.

- [ ] **Step 1: Wrap existing Customer Agent behavior**

Delegate history, creation, run, abort, and delete to the existing host/store without changing its persistence semantics. Mark an active host run as `owned-by-customer-agent`.

- [ ] **Step 2: Aggregate runtimes independently**

Call every healthy adapter, convert failures into runtime health diagnostics, flatten and sort successful results by `updated`, and match native `cwd` to the most-specific registered project path. Preserve sessions with no matching project under an empty/synthetic project key.

- [ ] **Step 3: Route operations by encoded ID**

Decode once at the service boundary and route `get`, `run`, `abort`, `answerQuestion`, and `delete` to exactly one adapter. Reject delete for external runtimes and recheck occupancy before run.

- [ ] **Step 4: Register the service with Electron IPC**

Replace session list/get/create/delete handlers and agent run/abort routing with unified handlers while preserving legacy Customer Agent IDs. Add `sessions:runtimeHealth`, `sessions:refresh`, and a create payload containing `{ title, projectId, agentType }`.

- [ ] **Step 5: Add focused unit tests**

Cover partial runtime failure, aggregate sorting, most-specific project match, unmatched paths, route decoding, external delete rejection, occupancy race, event `_sid` preservation, and legacy Customer Agent calls.

### Task 5: Preload Contract And Desktop UX

**Files:**
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Create: `packages/desktop/renderer/components/RuntimeSessionMenu.tsx`
- Unit tests: `packages/desktop/renderer/components/RuntimeSessionMenu.test.tsx`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/desktop/renderer/lib/chat-command.ts`
- Unit tests: `packages/desktop/renderer/lib/chat-command.test.ts`

**Interfaces:**
- Consumes: unified session and health objects exposed by Task 4.
- Produces: runtime-aware sidebar, create menu, occupied read-only chat, and runtime-routed sends.

- [ ] **Step 1: Type the renderer-facing IPC surface**

Expose typed `listSessions`, `getSession`, `createSession`, `refreshSessions`, `getRuntimeHealth`, runtime-aware `run`, and runtime-aware abort/answer methods.

- [ ] **Step 2: Add the runtime selection menu**

Open the menu from the existing plus icon. Show Customer Agent, Codex, and Claude Code with compact marks and runtime health. Disable unavailable choices and close after creation or outside click.

- [ ] **Step 3: Render runtime and occupancy state**

Add `CA`, `CX`, or `CC` to each session row. Show a lock icon and tooltip for externally occupied sessions. Suppress the delete action for external sessions.

- [ ] **Step 4: Make occupied sessions read-only**

Pass the selected summary into `ChatView`, render a read-only banner, disable composer submission, retain unsent drafts, and refresh occupancy periodically while the window is visible.

- [ ] **Step 5: Preserve command and voice behavior**

Default command/voice-created sessions to Customer Agent unless a runtime was explicitly selected in the visible new-session flow. Ensure encoded IDs continue routing message state and sidebar refresh callbacks.

- [ ] **Step 6: Add focused UI tests**

Cover menu choices and disabled health state, runtime labels, external delete suppression, occupied composer state, legacy Customer Agent creation, and encoded external-session send routing.

### Task 6: Integration Verification And Restart

**Files:**
- Modify only implementation or test files needed to fix verified failures.

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: a built and running desktop app with evidence for all three runtimes.

- [ ] **Step 1: Run targeted unit tests**

```bash
bunx vitest run packages/desktop/main/agent-runtime packages/desktop/renderer/components/RuntimeSessionMenu.test.tsx packages/desktop/renderer/lib/chat-command.test.ts
```

- [ ] **Step 2: Run desktop and repository type/build checks**

```bash
bun run --cwd packages/core build
bun run --cwd packages/desktop build
bunx tsc --noEmit
```

- [ ] **Step 3: Verify native discovery without persistence duplication**

Compare aggregate counts and sample IDs with `codex thread/list`, `~/.claude/projects`, and Customer Agent SQLite. Confirm external IDs do not appear as new rows in the Customer Agent `sessions` table.

- [ ] **Step 4: Verify occupancy and native continuation**

Keep one Codex and one Claude Code session open, confirm both are read-only, release each owner, refresh, and send a harmless follow-up. Confirm the follow-up appears in the same native history.

- [ ] **Step 5: Verify new sessions for all runtimes**

Create one session of each runtime under this project and send a harmless identity/status prompt. Confirm native IDs, working directory, streamed output, and post-restart rediscovery.

- [ ] **Step 6: Restart only Customer Agent desktop**

Stop the currently running Customer Agent Electron process, start the newly built desktop app, and verify the window loads with all three runtime groups. Do not terminate Codex or Claude Code owners.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/main/agent-runtime packages/desktop/renderer/components/RuntimeSessionMenu.test.tsx packages/desktop/renderer/lib/chat-command.test.ts packages/desktop/renderer/stores/agentStore.test.ts
```

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
