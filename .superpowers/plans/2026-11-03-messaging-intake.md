# Messaging Intake Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Integrate direct WeCom mentions with selectable model/rule routing, persisted execution and reply tracking, and a shared message audit page.

**Architecture:** Add a messaging bounded context in core with dependency-free domain types, an application service and SQLite repository. Server adapters own model inference, native execution, WeCom collection and delivery. Desktop and Web share a message list/detail page through an explicit authenticated messaging command.

**Tech Stack:** TypeScript, React, existing SQLite, existing model providers and native runtime; Python standard library and macOS CommonCrypto for WeCom source snapshots.

## Global Constraints

- Model routing is the default; rule routing uses only conversation/project/Agent mappings.
- Return to the originating conversation by default, with optional event subscriptions.
- Capture raw payload, routing evidence, project/Agent/session/run, execution outcome and separate delivery status.
- Reuse existing runtime execution; persist correlation and deduplicate incoming messages and receiving queue items.
- Only direct body mentions trigger execution; exclude own messages, quotes and all-members mentions.
- New encrypted-source snapshots must respect SQLite WAL locks and committed frame boundaries; decrypt the baseline once and update the mirror incrementally.
- Persist messages before advancing collection cursors; uncertain execution or delivery is visible and never blindly replayed.
- Match existing UI tokens and mobile behavior. Keep secrets out of API responses and audit payloads.
- Preserve the shared checkout. Use standard Git; no git-ai, no release or service restart in this implementation.

### Task 1: Core messaging domain and persistence

**Files:** Create `packages/core/src/domain/messaging/types.ts`, `routing.ts`; `application/messaging/ports.ts`, `MessagingService.ts`; `infrastructure/SQLiteMessagingRepository.ts`. Export from core index.

**Interfaces:** `MessagingService.receive(message)`, `process()`, `observe(record)`, `deliver()`; repository methods claim/update messages, store settings/cursors and independent deliveries.

- [x] Define normalized message, routing decision, execution and delivery records with distinct states. Store source identity as a unique key.
- [x] Implement pure candidate validation and simple rule selection:
  `decision.action === "dispatch" && candidates.some(p => p.id === decision.projectId)`.
- [x] Implement transactional compare-and-set claims, unique deliveries, durable source cursors, bounded pagination and raw detail lookup.
- [x] Implement application orchestration with persisted dispatch intent and receipt reconciliation. A dispatch with unknown receipt enters verification rather than resending.
- [x] Add focused tests for duplicate messages, invalid model candidates, route persistence, crash/receipt recovery, independent delivery failures and pagination.

### Task 2: Server routing, execution and delivery adapters

**Files:** Create `packages/server/lib/messaging/{routing,runtime,delivery,service}.ts`; `app/api/messaging/route.ts`. Modify native queue deduplication only at its existing receiving boundary.

**Interfaces:** Existing project catalog supplies canonical directories; current model profile supplies routing inference. Runtime dispatch accepts `sourceMessageId` and returns queue item/session/run receipt.

- [x] Route with existing ModelRegistry, no tools, bounded context, structured output and catalog validation. Rule and model errors remain inspectable.
- [x] Enforce request-approval/read-only mode before native admission; offer only runtimes whose adapter enforces the boundary.
- [x] Persist correlation to dedicated sessions. Reconcile by sourceMessageId, replay run events with runId/sequence and preserve waiting/failed/aborted/completed distinctions.
- [x] Deliver selected events to origin/extra targets with independent attempt records. Ambiguous sends enter unknown; explicit failures support bounded retry.
- [x] Add validated command API for dashboard/list/detail/settings/source discovery/retry/manual routing. Authenticate through existing server middleware and transports.
- [x] Restore the worker at server startup; record worker/collector errors and next actions.

### Task 3: WeCom source adapter

**Files:** Create `packages/server/lib/messaging/wecom/{codec.py,reader.py,reader_test.py,collector.ts}`. Include Python assets in runtime packaging.

**Interfaces:** Reader emits JSON batches with a cursor, raw message, decoded body, direct mention targets and source generation. Collector persists each batch before acknowledging the cursor.

- [x] Reuse reviewed codec functions with attribution to the local research implementation; keep account IDs as strings across JavaScript.
- [x] Acquire shared locks on checkpoint/read-zero/read-one WAL slots, freeze source/WAL snapshots, validate committed frames and update a private mirror incrementally.
- [x] Traverse every repeated body segment. Preserve source bytes in base64, quotes/attachments as metadata, stable RID/sequence identity, and local LID only as an incremental cursor.
- [x] Seed from activation time, persist cursor/generation and rescan on generation changes with inbox deduplication.
- [x] Autodiscover accounts/databases without embedding this machine's paths. Show unavailable/multiple accounts clearly.
- [x] Add codec/parser/snapshot tests, including repeated mentions, quoted mentions, IDs above JavaScript's safe integer range, partial WAL and restart.

### Task 4: Shared audit page and settings

**Files:** Create `packages/desktop/renderer/components/messaging/{MessagingPage,MessageDetail}.tsx`, `messaging.css`, `client.ts`; integrate App navigation, preload bridge and Web gateway.

**Interfaces:** Command `messaging({action:"list",...})` returns paginated messages and worker summary; detail includes evidence and deliveries; settings retain one routing-mode selector and optional simple rules/subscriptions.

- [x] Render searchable/filterable list with received time, source, message, model/rule, target, execution and reply columns.
- [x] Render detail with raw payload expansion, routing model/reason, session navigation, event timeline, result and per-target delivery receipt/error.
- [x] Provide collector start/pause, source discovery, model/rule selector and extra subscription controls with honest empty/error states.
- [x] Add a Message Intake entry in the shared workspace and standalone Web view. Keep desktop/Web transport parity.
- [x] Add static-render and client tests for failure/completion distinctions, raw payload display and native session deep links.

### Task 5: Verification and capture

- [x] Review the full feature diff against project CLAUDE.md and the approved simplified design.
- [x] Run affected tests and TypeScript checks; fix feature regressions and distinguish unrelated baseline failures.
- [x] Build shared Web UI and verify the page using ego-browser against an isolated local test service.
- [ ] Real encrypted-source read and live channel acceptance: the current test process is denied access to the WeCom container by macOS. Discovery/error handling and encrypted snapshot fixtures pass; no real model task or chat send was performed.
- [x] Capture actual implementation and remaining environment limitations in wiki; report branch/worktree, tests and activation state.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/core/src/application/messaging packages/core/src/infrastructure/SQLiteMessagingRepository.test.ts packages/core/src/domain/messaging packages/core/src/domain/session/SessionGoals.test.ts packages/server/lib/messaging packages/desktop/renderer/components/messaging packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`.

Run: `python3 -m unittest discover -s packages/server/lib/messaging/wecom -p '*_test.py'`.

Expected: PASS. Then build core/native-runtime/Web UI and run affected TypeScript checks. Fix failures before reporting completion.

## Verification results (2026-11-03)

- 221 TypeScript tests across 14 files pass, including native message receipts, routing, outbox, Web/Desktop transport and Web tab recovery.
- Five Python tests pass, including repeated body segments, large IDs, incremental encrypted WAL frames and real SQLite checkpoint/reset locks.
- Core, computer-use, native-runtime and shared Web UI builds pass. Server TypeScript and messaging UI TypeScript pass.
- Full desktop TypeScript still reports pre-existing chat/sidebar/config errors; unrelated code was not rewritten.
- Full Next production compilation exhausts 4 GB and 8 GB Node heaps; a bounded Node 22 retry also exhausts 4 GB. The build issue is unresolved and is not classified as a proven baseline issue.
- Isolated loopback QA uses synthetic records only. API list/detail/validation and desktop/mobile messaging views are verified. Web shell entry, iframe readiness and session forwarding are checked separately.
- Production :3000 service, shared checkout and real chat delivery are unchanged. Listener is disabled by default. No commit, push, deploy or package publish performed.

## 3000 activation follow-up (2026-11-03 20:32 CST)

- User explicitly authorized starting :3000 with the latest code. A flat release snapshot combines current master working changes, upstream directory-rename fixes and this feature, without changing the shared checkout.
- All five package/UI/Next production builds pass; server typecheck and 259 combined regression tests pass. Two added cancellation-result regressions also pass in the feature checkout.
- Waited for another live native run to finish; restarted only the original webapp LaunchAgent. New PID 23196, Next BUILD_ID Y4QkjRD07CkORESxUaEao. Three stable PID samples, actual resource hash, original session read and browser message-page entry pass.
- DataDir remains the original server directory. Listener stays disabled; no real WeCom receive/send acceptance claimed.
- Evidence: /Users/caoqu/.codex/artifacts/agentroam-messaging-3000-20261103-200204/.
