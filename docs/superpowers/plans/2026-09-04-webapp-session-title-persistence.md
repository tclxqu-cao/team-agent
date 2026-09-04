# WebApp Session Title Persistence Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the first non-empty user message as the title of newly created placeholder sessions without changing historical or explicitly titled sessions.

**Architecture:** Core owns the placeholder and metadata rules. Customer Agent hosts persist the title in their session stores, while the native runtime broker stores an AgentRoam-only title override and consumes its pending marker inside the existing run-admission SQLite transaction.

**Tech Stack:** TypeScript, Vitest, SQLite/better-sqlite3, Electron main process, Next.js API server, native runtime broker.

## Global Constraints

- Only sessions created after this change with the exact system placeholder title `新会话` are eligible.
- Existing sessions are never inferred or backfilled from message history.
- The first non-empty user input supplies at most 60 JavaScript characters; later inputs cannot overwrite it.
- Native titles are AgentRoam display overrides and do not need to rename external Codex, Claude Code, or OpenCode records.
- Preserve all unrelated dirty-worktree changes and edit only the required hunks.

---

### Task 1: Shared Auto-Title Rule

**Files:**
- Create: `packages/core/src/domain/session/SessionTitle.ts`
- Modify: `packages/core/src/domain/session/index.ts`
- Unit tests: `packages/core/src/domain/session/SessionTitle.test.ts`

**Interfaces:**
- Consumes: `Session.metadata: Record<string, unknown>` and a user input string.
- Produces: `NEW_SESSION_PLACEHOLDER_TITLE`, `withPendingAutoTitle(title, metadata)`, and `consumePendingAutoTitle(session, input)`.

- [x] **Step 1: Add the shared title constants and metadata helper**

```ts
export const NEW_SESSION_PLACEHOLDER_TITLE = "新会话";
export const AUTO_TITLE_PENDING_METADATA_KEY = "autoTitleFromFirstMessage";

export function withPendingAutoTitle(
  title: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return title === NEW_SESSION_PLACEHOLDER_TITLE
    ? { ...metadata, [AUTO_TITLE_PENDING_METADATA_KEY]: true }
    : metadata;
}
```

- [x] **Step 2: Add one-shot title consumption**

```ts
export function consumePendingAutoTitle(
  session: Pick<Session, "metadata">,
  input: string,
): { title: string; metadata: Record<string, unknown> } | null {
  if (session.metadata[AUTO_TITLE_PENDING_METADATA_KEY] !== true || !input.trim()) return null;
  const metadata = { ...session.metadata };
  delete metadata[AUTO_TITLE_PENDING_METADATA_KEY];
  return { title: input.slice(0, 60), metadata };
}
```

- [x] **Step 3: Export the helper and cover its exact eligibility rules**

Test placeholder marking, explicit-title passthrough, blank-input preservation, 60-character truncation, metadata-key removal, and refusal to consume an unmarked historical session.

### Task 2: Customer Agent Persistence

**Files:**
- Modify: `packages/server/app/api/agent-host.ts:191-217,335-343`
- Modify: `packages/desktop/main/agent-host.ts:457-468,591-611`
- Unit tests: `packages/server/app/api/agent-host.test.ts`
- Unit tests: `packages/desktop/main/agent-host-run-state.test.ts`

**Interfaces:**
- Consumes: `withPendingAutoTitle()` during creation and `consumePendingAutoTitle()` immediately before the first user message is stored.
- Produces: SQLite sessions whose title and metadata transition together exactly once.

- [x] **Step 1: Mark eligible CA sessions at creation**

Wrap the existing `{ permissionMode: "full-access" }` metadata in `withPendingAutoTitle(title, ...)` in both hosts.

- [x] **Step 2: Consume the title before storing the first user message**

In Web Server `run`, update the fetched session with the returned title/metadata before `addMessage`. In Desktop `run`, replace the current “always update title to latest message” branch with a status update plus the optional one-shot title/metadata update.

- [x] **Step 3: Cover new, explicit, and historical CA sessions**

Assert that a newly marked placeholder becomes the first input title, an explicit title stays unchanged, and a manually created historical-looking `新会话` without the marker stays unchanged.

### Task 3: Native Broker Title State

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts:176-249,372-410,575-604,787-792,823-868`
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: `NEW_SESSION_PLACEHOLDER_TITLE`, a newly created unified native session ID, and the `message` already passed into `NativeRuntimeBrokerState.admit()`.
- Produces: `native_runtime_session_title` rows and summary/detail title overrides.

- [x] **Step 1: Add persistent broker title storage**

Create `native_runtime_session_title(session_id PRIMARY KEY, title, auto_title_pending, updated_at)`. Add `trackPendingAutoTitle(sessionId, title)` that inserts a row only for the exact placeholder title, and `getDisplayTitle(sessionId)` for projections.

- [x] **Step 2: Consume the pending title inside run admission**

After the active-run check but inside the same `admit()` transaction, conditionally update a pending row to `message.slice(0, 60)` when `message.trim()` is non-empty. A failed or losing admission rolls the title update back with the run transaction.

- [x] **Step 3: Apply and persist the override**

Call `trackPendingAutoTitle` after native session creation. In `applySummary`, replace only `title` when a stored display title exists; `applyDetail` inherits the same result.

- [x] **Step 4: Cover every native runtime and restart behavior**

Use parameterized Codex, Claude Code, and OpenCode create/start/list assertions. Add broker replacement coverage proving the title survives process state reconstruction, plus a no-marker case proving historical placeholder sessions do not change.

### Task 4: Integration Regression

**Files:**
- Modify only when a failing contract requires it: `packages/server/app/api/native-runtime.test.ts`
- Modify only when a failing renderer contract requires it: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: unchanged `/api/sessions` and native broker request contracts.
- Produces: confirmation that no frontend rename endpoint or renderer behavior change is needed.

- [x] **Step 1: Verify API compatibility**

Confirm session creation and run routes keep their existing request bodies and status codes; add an assertion only if current route tests do not exercise refreshed titles.

- [x] **Step 2: Verify renderer compatibility**

Keep the existing optimistic `onMessageSent` title update. Confirm `onRunComplete` refresh now receives the same persisted title rather than reverting it.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
npx vitest run \
  packages/core/src/domain/session/SessionTitle.test.ts \
  packages/server/app/api/agent-host.test.ts \
  packages/desktop/main/agent-host-run-state.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/server/app/api/native-runtime.test.ts
npx tsc -p packages/core/tsconfig.json --noEmit
npx tsc -p packages/desktop/tsconfig.json --noEmit
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p packages/webapp/tsconfig.json --noEmit
git diff --check
```

Expected: all focused tests and type checks pass with no diff whitespace errors.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
