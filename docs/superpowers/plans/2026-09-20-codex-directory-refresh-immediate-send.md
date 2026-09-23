# Codex Directory Refresh And Immediate Send Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ordinary submitted message paint before Codex run admission, while refreshing real Codex workspaces on expansion and preserving Codex Desktop session order with stable running-first grouping.

**Architecture:** Add a browser paint-boundary utility and expose it as an optional post-optimistic-message hook in the existing chat-command orchestration. Keep session ordering in the sidebar sort module: Codex retains runtime source order, other agents retain newest-created order, and running-first only partitions the chosen base order.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Vite.

## Global Constraints

- Do not alter Codex native protocols, session creation, durable queue admission, history pagination, or deployment state.
- Preserve cached workspace rows while refreshing.
- Do not force-refresh the derived Codex `codex:recent` workspace.
- Preserve unrelated dirty-worktree changes.
- Use Node 22-compatible project commands for validation.

---

### Task 1: Browser Paint Boundary

**Files:**
- Create: `packages/desktop/renderer/lib/browser-paint.ts`
- Create: `packages/desktop/renderer/lib/browser-paint.test.ts`

**Interfaces:**
- Produces: `waitForNextPaint(target?: PaintTarget): Promise<void>`.
- Consumes: browser `requestAnimationFrame`, `setTimeout`, and `clearTimeout` scheduling.

- [x] **Step 1: Add the paint scheduler utility**

Implement a foreground path that resolves from a zero-delay task scheduled inside the next animation-frame callback, so React commits and the browser paints before send work resumes. Add a bounded timeout fallback so a hidden or throttled document cannot block sending indefinitely.

```ts
export function waitForNextPaint(target: PaintTarget = window): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      target.clearTimeout(fallbackId);
      resolve();
    };
    const fallbackId = target.setTimeout(finish, 100);
    target.requestAnimationFrame(() => target.setTimeout(finish, 0));
  });
}
```

- [x] **Step 2: Cover frame ordering and fallback**

Use an injected fake target to prove the promise remains pending after scheduling, remains pending when only the frame callback runs, resolves from the task after that frame, and also resolves from the 100 ms fallback when no frame is delivered.

---

### Task 2: Ordinary Message Paint Before Run Admission

**Files:**
- Modify: `packages/desktop/renderer/lib/chat-command.ts`
- Modify: `packages/desktop/renderer/lib/chat-command.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx:3236`
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `waitForNextPaint()` from Task 1.
- Produces: optional `afterUserMessageShown?: () => void | Promise<void>` on `PrepareChatCommandOptions`.

- [x] **Step 1: Add an explicit post-message hook to chat command preparation**

Call the hook immediately after `activateSession()` and `showUserMessage()`, before awaiting new-session selection work.

```ts
options.activateSession(targetSessionId);
options.showUserMessage(options.text, targetSessionId);
await options.afterUserMessageShown?.();
if (isNewSession) await options.onSessionCreated?.(targetSessionId);
```

- [x] **Step 2: Test the orchestration order**

Add a deferred promise test proving `showUserMessage` occurs before the hook, `prepareChatCommand` stays pending until the hook resolves, and `onSessionCreated` follows it. Retain all existing creation and existing-session assertions.

- [x] **Step 3: Wire only the ordinary send path to the paint boundary**

Import `waitForNextPaint` in `ChatView`. In the normal-send `prepareChatCommand` call, keep the non-reactive running-session ref needed by history guards, avoid setting visible running state in `activateSession`, pass `afterUserMessageShown: waitForNextPaint`, then let `startRun()` set visible running state and call the Agent API after the boundary. Do not change goal, queued, slash-command, cron, or voice paths.

- [x] **Step 4: Update the renderer contract test**

Assert the ordinary-send source slice includes `afterUserMessageShown: waitForNextPaint` before `await startRun(` and that goal preparation does not opt into the paint hook.

---

### Task 3: Codex Source Order And Stable Running Partition

**Files:**
- Modify: `packages/desktop/renderer/lib/sidebar-session-sort.ts`
- Modify: `packages/desktop/renderer/lib/sidebar-session-sort.test.ts`
- Modify: `packages/desktop/renderer/App.tsx:97`
- Modify: `packages/desktop/renderer/components/SidebarReferenceStyle.test.ts`

**Interfaces:**
- Produces: `orderSessionsForAgent(sessions, agentType)` returning a copied source-order array for Codex and newest-created order for other agents.
- Changes: `sortRunningSessionsFirst(sessions, isRunning)` becomes a stable partition of its input order.

- [x] **Step 1: Encode Agent-specific base ordering**

Add `orderSessionsForAgent` beside the existing sort helpers and update the running helper to partition its input without calling `sortNewestSessionsFirst` internally.

```ts
export function orderSessionsForAgent<T extends SortableSidebarSession>(
  sessions: readonly T[],
  agentType: AgentType,
): T[] {
  return agentType === "codex" ? [...sessions] : sortNewestSessionsFirst(sessions);
}
```

- [x] **Step 2: Extend sorting tests**

Prove Codex preserves updated/source order, Customer Agent still sorts by `created`, running-first preserves the relative order of running and idle groups, and no helper mutates its input.

- [x] **Step 3: Apply ordering during cache restore and page reconciliation**

Pass the active Agent into `buildCachedSessionState()`. Use `orderSessionsForAgent` for root sessions restored from cache and roots returned by `loadSessions()`. Keep child-session chronological ordering unchanged. This ensures pagination and refresh continue from the runtime-provided Codex order.

- [x] **Step 4: Refresh real Codex workspaces on every expansion**

In both single-project toggle and expand-all paths, request `refresh: true` with background mode when cached for Codex workspaces whose `canCreateSession !== false`. Preserve the current cache-aware behavior for other agents and for `codex:recent`.

```ts
const refresh = activeAgentRef.current === "codex" && project.canCreateSession !== false
  ? true
  : hasCache;
void loadSessions(projectId, { refresh, background: hasCache });
```

- [x] **Step 5: Update sidebar source contracts**

Replace the old assertion that uncached expansion always uses `refresh: hasCache` with assertions covering the Codex real-workspace refresh decision, the `canCreateSession !== false` recent-workspace guard, and stable source ordering.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/renderer/lib/browser-paint.test.ts packages/desktop/renderer/lib/chat-command.test.ts packages/desktop/renderer/lib/sidebar-session-sort.test.ts packages/desktop/renderer/components/ChatHistoryStyle.test.ts packages/desktop/renderer/components/SidebarReferenceStyle.test.ts
bun run --cwd packages/webapp typecheck
bunx tsc --noEmit -p packages/desktop/tsconfig.json
git diff --check
```

Expected: all focused tests pass, both TypeScript checks pass, and `git diff --check` reports no errors.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the command and result in the final response.

Verification result (2026-09-20): the 20 focused utility/orchestration/sort tests and the two new renderer contract cases pass; desktop TypeScript, the WebApp production build, and `git diff --check` pass. The full WebApp typecheck remains blocked by five unrelated pre-existing errors in `client-error-reporter.ts` and `main.tsx`. The full legacy renderer style suites also retain three unrelated pre-existing source-contract failures.
