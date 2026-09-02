# Native Runtime Client-Scoped Project Projection Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the shared native runtime broker project-neutral and make Web project-scoped session queries use the Web server's own project catalog.

**Architecture:** The broker host discovers native sessions with an empty project catalog so its summaries remain portable across clients. `NativeRuntimeService` becomes the Web client's projection boundary: it loads local projects, authoritatively maps session `cwd` values to the most specific project, merges pending sessions, and only then applies an optional `projectId` filter.

**Tech Stack:** TypeScript, Node.js Unix sockets, Next.js route handlers, SQLite project storage, Vitest.

## Global Constraints

- Preserve the shared broker's run, approval, lock, retained-event, and handoff behavior.
- Preserve Desktop project association through its outer `UnifiedSessionService`.
- Treat the requesting client's project catalog as authoritative and clear foreign project IDs before matching by `cwd`.
- Do not modify unrelated files already changed in the working tree.

---

### Task 1: Make Broker Discovery Project-Neutral

**Files:**
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`

**Interfaces:**
- Produces: `createNativeRuntimeBrokerHostRuntime(codexExecutable?: string, callbacks?: Partial<NativeRuntimeBrokerCallbacks>): UnifiedSessionService`
- Preserves: `NativeRuntimeBrokerClient` and `BrokerRuntimeAdapter` public behavior.

- [x] **Step 1: Remove the host project loader from the broker runtime factory**

Change `createNativeRuntimeBrokerHostRuntime` to construct `UnifiedSessionService` with `() => Promise.resolve([])` so discovered broker summaries never depend on the first host's project database.

- [x] **Step 2: Update Desktop and Web factory call sites**

Pass only the Codex executable and callbacks. Desktop continues to associate the raw broker summaries in its outer `UnifiedSessionService`.

### Task 2: Add Web Client Project Projection

**Files:**
- Modify: `packages/server/lib/native-runtime-service.ts`
- Unit tests: `packages/server/lib/native-runtime-service.test.ts`

**Interfaces:**
- Consumes: local projects shaped as `{ id: string; description: string }`.
- Produces: `new NativeRuntimeService(runtime, listProjects)` where `listProjects(): Promise<ProjectLike[]>` defaults to an empty list for isolated tests.

- [x] **Step 1: Add authoritative cwd-based association**

Normalize session and project paths with `resolve()`, select the longest matching project path, clear any incoming `projectId`, and attach only the matching local project ID.

- [x] **Step 2: Project list and refresh results before filtering**

Call the broker without a project filter, associate all returned summaries locally, merge projected pending sessions, and filter the merged result only when the caller supplied `projectId`.

- [x] **Step 3: Project create, fork, and detail results**

Associate returned summaries before adding them to the pending registry or returning them. Apply the same authoritative projection to normal detail responses; pending-detail fallback retains the already projected summary.

- [x] **Step 4: Inject the Web project store**

Construct `NativeRuntimeService` with `() => new SQLiteProjectStore(getServerBaseDir()).list()` while keeping the broker runtime factory project-neutral.

### Task 3: Add Focused Regression Coverage

**Files:**
- Modify: `packages/server/lib/native-runtime-service.test.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts` only if a shared helper is introduced.

**Interfaces:**
- Verifies: caller-local project association and exact scoped filtering.
- Verifies: foreign broker project IDs cannot survive Web projection.

- [x] **Step 1: Extend the fake runtime to record list scope**

Record `list` and `refresh` arguments so the tests prove Web requests the unfiltered broker list.

- [x] **Step 2: Test local mapping and project-scoped results**

Use a native session under `/repo/app` and local projects `/repo` plus `/repo/app`; assert the most specific local ID is returned for the matching scope.

- [x] **Step 3: Test foreign ID replacement and nonmatching scopes**

Give the broker summary a foreign `projectId`, assert Web replaces it by `cwd`, and assert another requested project returns no native sessions.

- [x] **Step 4: Test projected pending sessions**

Create a session under a local project, assert it stays visible in that project's scoped list before discovery returns it, then assert discovery promotion removes the duplicate.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/server/lib/native-runtime-service.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/desktop/main/agent-runtime/unified-session-service.test.ts`

Run: `bunx tsc -p packages/server/tsconfig.json --noEmit`

Run: `bun run --cwd packages/server build`

Expected: all tests, type checking, and production build pass. Then stop the temporary `:3001` process, restart the launchd-managed `:3000` service, and verify the project-scoped sessions endpoint plus runtime health in the browser.
