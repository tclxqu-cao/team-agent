# Group deletion cancels associated schedules

> **For the main agent:** Implement directly in this session, without subagents. Run the affected tests after implementation and fix failures before delivery.

**Goal:** Deleting a group cancels its explicitly associated schedules and stops supervision before deletion succeeds.

**Architecture:** Persist typed schedule bindings on the group. The application validates deletion eligibility, awaits the runtime cleanup port, and then marks the group deleted. Runtime adapters cancel exact task identities through their owning schedulers; unavailable cancellation fails deletion visibly. Repeating deletion retries cleanup safely.

**Tech Stack:** TypeScript, SQLite, Next.js, native Harness RPC, Vitest, Python legacy helper.

## Constraints

- Preserve current dirty changes and unrelated schedules, original business sessions, files and history.
- No direct writes to a running Harness schedule store; use its authenticated schedule/delete RPC and verify absence.
- Never recreate a user-deleted group. Legacy helper exits when its group is missing.
- Project docs remain unchanged; this plan is local under .superpowers.

## Task 1: Typed lifecycle and stopping

- [x] Add CollaborationScheduledTask = { agentType: "customer-agent"; taskId: string } | { agentType: "deepseek-harness"; taskId: string; sessionId: string }, optional CollaborationGroup.scheduledTasks, and validate bindings at HTTP/domain boundaries.
- [x] Add CollaborationRuntime.beforeDeleteGroup?(group: CollaborationGroup): Promise<void>; validate busy-group rules before calling it, await it before persisting deletion, and allow repeated deletion to retry cleanup. A bound schedule without a cleanup implementation fails.
- [x] Add SupervisionService.stop(groupId: string): void, persisting paused=true plus a new generation and aborting only that group's diagnostics, including already-deleted groups.
- [x] Test cancellation ordering/failure, busy groups, retry idempotence and late diagnostic completion after stop.

## Task 2: Owned scheduler adapters and integration

- [x] Add DeepSeekHarnessScheduleClient.cancel(sessionId: string, taskId: string): Promise<void>, reusing current-host discovery; call schedule/delete with { request: { sessionId, id: taskId } }, accept already-absent records, then schedule/catalog to verify absence. Never launch a replacement Host for cancellation.
- [x] Add a server group-schedule cancellation adapter for exact local CronTasks IDs and native Harness bindings. Implement ServerCollaborationRuntime.beforeDeleteGroup using supervision.stop plus schedule cancellation; expose scheduledTasks in the existing group schema.
- [x] Update the delete dialog to explain that monitoring and associated schedules stop while original business sessions are preserved.
- [x] Test RPC errors, wrong identities, still-present tasks, unrelated schedules and propagation of cancellation failures.

## Task 3: Legacy incident and live activation

- [x] Back up the identified task and helper; remove the helper's heal() recreation path and exit when its group is deleted.
- [x] Cancel only the confirmed stray Harness task through live RPC, pause/delete its automatically recreated group, and verify unrelated schedules/business sessions remain.
- [x] Build Core/native-runtime/WebApp/Next with Node 22 and isolated WebApp/Next outputs; preserve rollback and existing source snapshots; activate only 3000 when safe.
- [x] Verify the real deleteGroup route with an isolated group and a harmless associated scheduler task, then check scheduler absence, group deletion, stable PID, API and browser state.

## Final Unit Test Verification

- [x] Run the changed collaboration/supervision domain and service tests, scheduler adapter tests, and server runtime tests with bunx vitest run.
- [x] Confirm package builds, review the diff against the original snapshots, and capture the verified behavior in Wiki.
