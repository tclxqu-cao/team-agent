# Supervision Queued Decisions Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A replied supervision decision remains pending while its original instruction is queued or running, without another decision prompt or duplicate send.

**Architecture:** Persist the queue message identity and delivery status in intervention receipts. Read the native queue without resuming it and correlate the active broker run to that message. Reconcile existing receipts before evaluating progress, preserve legacy receipts, and atomically claim each answer before asynchronous admission.

**Tech Stack:** TypeScript, SQLite, native runtime broker, Next.js, React, Vitest.

## Global Constraints

- Preserve existing collaboration, image, dashboard and supervision-journal changes in this shared checkout.
- Keep plans in `.superpowers/plans/`; do not modify project docs or commit/push code.
- Do not cancel, replay, or send real business messages during verification; deployment is outside this request.
- Preserve original question IDs/options, user stop behavior, cross-group claims, and bounded automatic recovery.

## Task 1: Correlate receipts with durable queue items

**Files:** `packages/core/src/domain/supervision/types.ts`, `packages/core/src/application/supervision/ports.ts`, `packages/native-runtime/src/agent-runtime/native-runtime-broker.ts`, `packages/server/lib/native-runtime-service.ts`, `packages/server/lib/supervision/runtime.ts`.

**Interfaces:** `InterventionReceipt` gains optional `messageId`, `status`, `reason`; `SupervisionRuntime.interventionStatus(target, actionId)` reads the matching `sourceMessageId`; `getGoals(id, controller, resume = true)` accepts `false` for read-only inspection; snapshots identify `queueItemId`.

- [x] Add receipt and queued-incident types; keep legacy receipt fields compatible.
- [x] Implement `if (!resume) return this.state.getGoalState(sessionId)` through host/client/service; add `queueItemId: projection.run?.goalId` to snapshots.
- [x] Match `sourceMessageId === supervision:${actionId}` across active, queued and history; only report running when the matching item owns the broker run.
- [x] Return queue status and message identity from continuation, with accurate journal wording for queued versus started admission.

## Task 2: Reconcile pending decisions and make answers idempotent

**Files:** `packages/core/src/application/supervision/SupervisionService.ts`, `packages/core/src/domain/supervision/messages.ts`, `packages/desktop/renderer/components/collaboration/SessionDashboard.tsx`.

**Interfaces:** Reconciliation consumes `InterventionReceipt`; queued incidents remain unresolved and retain target claims, but do not appear as waiting decisions.

- [x] Poll correlated delivery before generic progress/timeout checks, including legacy accepted receipts that have returned to waiting.
- [x] Keep queued/running instructions quiet after 60 seconds; settle only on correlated completion/failure/cancellation or verified new progress.
- [x] Return the existing state for repeated replies while a prior action is pending; claim the answer using a generation-safe save before invoking runtime admission.
- [x] Show queued state in the existing incident history and supervision journal.

## Task 3: Cover the original trigger and integration boundaries

**Files:** focused supervision service/runtime tests, native broker tests and affected dashboard tests.

- [x] Test `queued -> repeated polls beyond 60s -> repeated continue -> still one send`, then matching execution and completion.
- [x] Test legacy receipt repair, restart, concurrent replies, unrelated source progress, terminal queue failure/cancellation and manual stop.
- [x] Test readonly queue inspection through the socket client, including an active item without a broker run.
- [x] Check receipt/journal semantics when the broker starts an older queue item instead of the newly added supervision instruction.

## Final Unit Test Verification

- [x] Main agent: run affected unit tests after development is complete: `bunx vitest run packages/core/src/application/supervision packages/core/src/infrastructure/SQLiteSupervisionRepository.test.ts packages/server/lib/supervision packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts packages/desktop/renderer/components/collaboration/SessionDashboard.test.tsx`.
- [x] Build core and native runtime declarations; run affected package typechecks and review the isolated diff against preserved files.
- [x] Update the wiki capture with the final behavior, verification and deployment boundary.
