# Desktop Live Viewer-Driven Display Wake Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Mac display awake only while at least one WebApp peer watches the published desktop live session, releasing it immediately after the last watcher leaves.

**Architecture:** Keep desktop live publication and its persisted enable switch unchanged. Consume the existing `browser:state.session.viewerCount` events inside `DesktopScreenLive`, transition `DisplayKeepAwake` only across the zero-viewer boundary, and force the local viewer state back to zero when the producer disconnects or the feature is disabled.

**Tech Stack:** TypeScript, Electron `powerSaveBlocker`, `@agent/core` live-view protocol, Vitest, Bun, Node 22.

## Global Constraints

- Do not change the `browser:*` wire protocol, `LiveViewRegistry`, server routes, WebApp components, or the CLI `caffeinate -i` behavior.
- Treat `viewerCount` from the matching `desktop:primary` `browser:state` event as the authoritative viewing state.
- Release the AgentRoam display assertion immediately when the last watcher leaves.
- Preserve multiple-viewer semantics: counts above zero remain one logical display-awake state.
- Invalid, missing, negative, fractional, or foreign-session viewer counts must not change the current display assertion.
- Use the existing idempotent `DisplayKeepAwake.start()` and `stop()` adapter; add no dependency or new protocol message.
- Preserve `.agent/skills/wiki-query/log.md` and `packages/desktop/.agent-data/` as unrelated untracked paths.

---

### Task 1: Move display power lifecycle to viewer presence

**Files:**
- Modify: `packages/desktop/main/desktop-screen-live.ts`
- Unit tests: `packages/desktop/main/desktop-screen-live.test.ts`

**Interfaces:**
- Consumes: producer events shaped as `{ type: "browser:state", session: { id: string, viewerCount: number, state?: LiveViewOwnershipState } }`.
- Produces: a private `#syncViewerCount(value: unknown): void` method that calls `keepAwake.start()` on `0 -> positive` and `keepAwake.stop()` on `positive -> 0`.

- [x] **Step 1: Add explicit viewer-presence state**

In `DesktopScreenLive`, add a numeric field initialized to zero:

```ts
private viewerCount = 0;
```

Add the transition helper:

```ts
#syncViewerCount(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return;
  const previous = this.viewerCount;
  const next = Number(value);
  this.viewerCount = next;
  if (previous === 0 && next > 0) this.keepAwake?.start();
  else if (previous > 0 && next === 0) this.keepAwake?.stop();
}
```

- [x] **Step 2: Stop acquiring the display assertion during feature enable**

Remove the `this.keepAwake?.start()` call and its adjacent comment from `#enable()`. Permission checks, input helper startup, session publication, and reconnect behavior remain unchanged.

- [x] **Step 3: Consume viewer counts from matching live-session events**

Change `#handleRelayEvent()` so it validates the session ID first, synchronizes `session.viewerCount`, and then independently updates the ownership state when present:

```ts
const session = event.session as {
  id?: string;
  state?: LiveViewOwnershipState;
  viewerCount?: unknown;
} | undefined;
if (!session || session.id !== this.metadata.sessionId) return;
this.#syncViewerCount(session.viewerCount);
if (!session.state) return;
this.status = { ...this.status, controlState: session.state };
this.#emit();
```

- [x] **Step 4: Release viewer-driven power state on every terminal producer path**

Call `this.#syncViewerCount(0)` at the beginning of `disable()` and in `#runLoop()` immediately after the current producer disconnects or returns, before publishing the offline status. This guarantees a dropped producer connection cannot leave `NoDisplaySleepAssertion` behind.

### Task 2: Replace enable-driven tests with viewer-driven coverage

**Files:**
- Modify: `packages/desktop/main/desktop-screen-live.test.ts`

**Interfaces:**
- Consumes: `DesktopScreenLive.enable()`, `disable()`, and captured `client.onEvent` callbacks.
- Produces: regression coverage for zero-boundary transitions, invalid inputs, foreign sessions, and producer disconnect cleanup.

- [x] **Step 1: Replace the old enable/disable power test**

Capture the producer listener, enable the live source, and assert that enabling alone does not call `keepAwake.start()`. Send matching `browser:state` events with counts `1`, `2`, `1`, and `0`; assert one start and one stop in total.

```ts
listener({ type: "browser:state", session: { id: DESKTOP_LIVE_SESSION_ID, viewerCount: 1 } });
listener({ type: "browser:state", session: { id: DESKTOP_LIVE_SESSION_ID, viewerCount: 2 } });
listener({ type: "browser:state", session: { id: DESKTOP_LIVE_SESSION_ID, viewerCount: 1 } });
listener({ type: "browser:state", session: { id: DESKTOP_LIVE_SESSION_ID, viewerCount: 0 } });
expect(keepAwake.start).toHaveBeenCalledTimes(1);
expect(keepAwake.stop).toHaveBeenCalledTimes(1);
```

- [x] **Step 2: Add invalid and foreign event coverage**

While one watcher is active, send missing, negative, fractional, string, and foreign-session counts. Assert none releases or reacquires the assertion. Then send the valid matching zero count and assert release.

- [x] **Step 3: Add disable cleanup coverage**

Activate one viewer, call `disable()`, and assert `keepAwake.stop()` runs exactly once and the existing gateway/session close expectations still pass.

- [x] **Step 4: Add producer disconnect cleanup coverage**

Use a controllable `screencast.start()` promise. After one viewer activates the assertion, resolve the screencast and assert the display assertion is released before the coordinator enters its retry sleep.

### Task 3: Rebuild and verify the running desktop behavior

**Files:**
- Verify: `packages/desktop/main/desktop-screen-live.ts`
- Verify: `packages/desktop/main/desktop-screen-live.test.ts`
- Verify: `packages/desktop/.runtime/agentroam.app`

**Interfaces:**
- Consumes: repository scripts `bun run --cwd packages/desktop compile` and `bun run dev:desktop`.
- Produces: a running Electron desktop process whose power assertion follows live viewer presence.

- [x] **Step 1: Compile the desktop package with Node 22**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/desktop compile
```

- [ ] **Step 2: Restart the desktop development App once the build passes**

Stop only the repository-owned `bun run dev:desktop` process tree after confirming no unrelated process owns it, then restart with:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run dev:desktop
```

- [ ] **Step 3: Verify the no-viewer baseline**

With `desktop-live.json` still enabled and no WebApp live panel open, run `pmset -g assertions`. Confirm the new AgentRoam Electron PID has no `NoDisplaySleepAssertion`. Ignore separately owned assertions such as `ego lite`.

- [ ] **Step 4: Verify watcher activation and immediate release**

Open the desktop live panel in WebApp and confirm the AgentRoam Electron PID gains `NoDisplaySleepAssertion`. Close the panel and confirm that specific PID's assertion disappears immediately; do not use the system-wide aggregate alone because other apps may keep it nonzero.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run packages/desktop/main/desktop-screen-live.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/desktop compile
git diff --check
```

Expected: the focused Vitest file passes, Desktop TypeScript compilation exits 0, and `git diff --check` prints no errors.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
