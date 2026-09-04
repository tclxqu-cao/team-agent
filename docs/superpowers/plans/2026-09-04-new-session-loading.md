# New Session Loading Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session creation acknowledge clicks immediately, prevent duplicates, and select the new conversation without waiting for Customer Agent workspace reconciliation.

**Architecture:** The shared renderer tracks one in-flight creation by Agent and workspace, backed by a synchronous ref guard. Both sidebar entry points consume that state; successful creation uses the existing optimistic workspace list and selection paths, while Customer Agent reconciliation runs in the background with the created summary preserved as an explicit pending row.

**Tech Stack:** TypeScript, React 18, Electron/WebApp shared renderer, Lucide React, Vitest.

## Global Constraints

- Only one new-session request may be active at a time.
- The bottom action must show `正在创建...`; the target workspace action must show a spinner.
- Loading feedback must preserve existing button dimensions and skin tokens.
- Session creation must not introduce a page-level overlay.
- A failed request must preserve the current selection, report the error, and clear loading state.
- Runtime creation protocols and server routes remain unchanged.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Shared Session Creation State And Flow

**Files:**
- Modify: `packages/desktop/renderer/App.tsx:1-3`
- Modify: `packages/desktop/renderer/App.tsx:175-205`
- Modify: `packages/desktop/renderer/App.tsx:881-926`

**Interfaces:**
- Consumes: `window.agentApi.createSession`, `sessionsByProjectRef`, `applySidebarSelection`, and `loadSessions(projectId, options)`.
- Produces: `sessionCreationPending: { projectId: string; agentType: AgentType } | null` and one guarded optimistic creation flow.

- [x] **Step 1: Add the spinner import and pending state**

Extend the Lucide import and define state plus a synchronous duplicate-click guard inside `App`:

```ts
import { History, LoaderCircle, Plus, Search } from "lucide-react";

const [sessionCreationPending, setSessionCreationPending] = useState<{
  projectId: string;
  agentType: AgentType;
} | null>(null);
const sessionCreationPendingRef = useRef(false);
```

- [x] **Step 2: Guard creation and always reset pending state**

In `handleNewRuntimeSession`, reject a second invocation through the ref before setting visible state. Wrap the request in `try/catch/finally`:

```ts
if (sessionCreationPendingRef.current) return;
sessionCreationPendingRef.current = true;
setSessionCreationPending({ projectId, agentType });
try {
  const created = await window.agentApi.createSession(/* existing arguments */) as Session;
  // Optimistic success flow from Step 3.
} catch (error) {
  setNotice(error instanceof Error ? error.message : "新建会话失败");
  setNoticeType("error");
  setTimeout(() => setNotice(null), 3000);
} finally {
  sessionCreationPendingRef.current = false;
  setSessionCreationPending(null);
}
```

Keep workspace capability validation before setting the guard so an invalid click does not flash loading.

- [x] **Step 3: Unify optimistic insertion and immediate selection**

Replace the Customer Agent blocking refresh branch and native-only insertion branch with one success path:

```ts
const projectSession = created.projectId === projectId ? created : { ...created, projectId };
const nextSessionsByProject = {
  ...sessionsByProjectRef.current,
  [projectId]: [
    projectSession,
    ...(sessionsByProjectRef.current[projectId] ?? []).filter((session) => session.id !== created.id),
  ],
};
sessionsByProjectRef.current = nextSessionsByProject;
setSessionsByProject(nextSessionsByProject);
applySidebarSelection({ projectId, sessionId: created.id });
if (mobileDrawer) setSidebarDrawerOpen(false);
if (agentType === "customer-agent") {
  void loadSessions(projectId, { refresh: true, background: true, pendingSession: projectSession });
}
```

This keeps the native empty-session discovery behavior and removes the extra Customer Agent list request from the selection critical path.

### Task 2: Sidebar Loading Feedback

**Files:**
- Modify: `packages/desktop/renderer/App.tsx:1342-1433`
- Modify: `packages/desktop/renderer/App.tsx:1591-1613`

**Interfaces:**
- Consumes: `sessionCreationPending` from Task 1 and the existing `spin` CSS keyframe.
- Produces: stable button-level pending visuals, disabled duplicate entry points, and accessible busy state.

- [x] **Step 1: Render loading in the workspace create action**

Inside the workspace map, derive the target state:

```ts
const isCreatingSession = sessionCreationPending?.agentType === activeAgent
  && sessionCreationPending.projectId === project.id;
```

Disable every workspace create action when `sessionCreationPending !== null`, set `aria-busy={isCreatingSession}`, and switch only the target icon:

```tsx
{isCreatingSession ? (
  <LoaderCircle size={13} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
) : (
  <Plus size={13} aria-hidden="true" />
)}
```

Use `正在创建会话` for the target action's title and accessible label. Keep the existing runtime-specific title when idle.

- [x] **Step 2: Render loading in the bottom action**

Add `sessionCreationPending !== null` to the native `disabled` expression and set `aria-busy={sessionCreationPending !== null}`. Preserve the no-workspace `aria-disabled` behavior. Replace content while pending:

```tsx
{sessionCreationPending ? (
  <>
    <LoaderCircle size={16} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
    <span>正在创建...</span>
  </>
) : (
  <>
    <Plus size={16} aria-hidden="true" />
    <span>新建会话</span>
  </>
)}
```

### Task 3: Focused Renderer Contract Coverage

**Files:**
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Consumes: the `App.tsx` loading and creation-flow source contract from Tasks 1 and 2.
- Produces: regression coverage for duplicate prevention, feedback, success ordering, background reconciliation, and failure cleanup.

- [x] **Step 1: Add pending UI assertions**

Add a focused test that asserts `LoaderCircle` is imported, both entry points consume `sessionCreationPending`, the bottom copy is `正在创建...`, the target action sets `aria-busy`, and the pending state participates in each create button's `disabled` expression.

- [x] **Step 2: Add creation lifecycle assertions**

Assert the handler contains the ref guard, `try/catch/finally`, the `新建会话失败` fallback, and both pending reset statements. Assert `applySidebarSelection({ projectId, sessionId: created.id })` appears before the background `loadSessions` call and that the old blocking `await loadSessions(projectId)` branch is absent.

### Task 4: Plan Tracking

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-new-session-loading.md`

**Interfaces:**
- Consumes: completed code and tests from Tasks 1 through 3.
- Produces: accurate checked-off implementation status.

- [x] **Step 1: Mark implemented steps complete**

Change each completed checkbox from `- [ ]` to `- [x]` only after the corresponding implementation and coverage exist.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/renderer/components/SidebarReferenceStyle.test.ts
bunx tsc --noEmit -p packages/desktop/tsconfig.json
bun run --cwd packages/webapp typecheck
git diff --check
```

Expected: the focused test passes, both shared-renderer consumers type-check, and the diff has no whitespace errors. If any command fails, fix the implementation or test and rerun until it passes.
