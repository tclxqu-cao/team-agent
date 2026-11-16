# Parallel Agent Conversations Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Create independent Agent sessions from one question, switch their existing chats using compact logo/status tabs, and select recipients for each subsequent message.

**Architecture:** Persist a lightweight conversation association in the shared server database, retaining each runtime's original session identity and transcript. Dispatch messages through the existing durable per-session queue, including each Agent's own model preferences; one admission failure must not cancel another recipient. Desktop and mobile use the same HTTP gateway and existing ChatView.

**Tech Stack:** TypeScript, React, SQLite, Next.js, Zustand, Vitest.

## Global Constraints

- Preserve the existing message, tool, permission, trace, and history rendering.
- Top tabs contain only an Agent logo and a status dot; viewing and sending are independent.
- Agent and recipient selection expand upward from the existing composer position.
- Native sessions receive the common host cwd, without borrowing another runtime's project ID.
- Read model catalogs dynamically; preserve drafts and successful sends when another recipient fails.
- Preserve all unrelated dirty changes. No commit, push, service restart, or project docs update is requested.
- `docs/code-standards.md` is absent. Follow root CLAUDE.md and the supplied AGENTS.md.

### Task 1: Persist associations and create independent sessions

**Files:** `packages/core/src/domain/session/ParallelSessions.ts`, `packages/core/src/infrastructure/SQLiteParallelSessionStore.ts`, their barrel exports, `packages/server/lib/parallel-sessions.ts`, `packages/server/app/api/sessions/parallel/route.ts`.

**Interfaces:** `ParallelSessionGroup<T extends ParallelSessionIdentity> = { id, title, cwd, created, members: T[] }`; `createParallelSessionGroup({title,cwd,agentTypes})`; `getParallelSessionGroup(sessionId)`.

- [x] Add the group type and validate 2..AGENT_TYPES.length distinct runtime types.
- [x] Store group JSON and uniquely indexed member IDs in one SQLite transaction, without transcript copies.
- [x] Create sessions using each native runtime's `create({agentType,cwd,title})`; resolve/import a Customer Agent project by cwd only when selected.
- [x] On a creation failure, clean up only new empty sessions from this attempt; return the original error. Runs start only after association persistence succeeds.
- [x] Return persisted creation summaries when reopening any member, without fetching all histories.

### Task 2: Preserve per-recipient run options in the durable queue

**Files:** `SessionGoals.ts`, the goals HTTP route, native broker queue admission, customer queue service, HTTP gateway and renderer AgentApi types.

**Interfaces:** `SessionMessagePayload.runOptions = {model?: {id,providerID?}, reasoningEffort?, profileId?}`; `enqueueSessionMessage(id, {sourceMessageId,content,images?,runOptions?})`.

- [x] Normalize and clone model/effort/profile options at untrusted HTTP and broker boundaries.
- [x] Pass each queued item's run options into native `startRun` and Customer Agent `startRun`.
- [x] Add gateway methods for group create/lookup and preserve ordinary single-session APIs.

### Task 3: Reuse the existing chat with multi-select and compact tabs

**Files:** `ComposerAgentPicker.tsx`, `ParallelAgentTabs.tsx`, `use-parallel-sessions.ts`, `parallel-message-dispatch.ts`, `ChatView.tsx`, `App.tsx`, `styles/composer.css`.

- [x] Extend the existing picker with controlled multiple selection, explicit completion, and non-empty selection; retain its single-choice callers.
- [x] Load associations by viewed session; retain recipients across result-tab switches and persist association server-side across reload/devices.
- [x] Render small logo/status tabs above the existing history. Use the existing ChatView session selection path to display each complete original chat.
- [x] At first send create the group, then enqueue the same payload independently to selected members. Use `Promise.allSettled` and session-specific optimistic messages/errors.
- [x] Subsequent sends target one, a subset, or all participants; failed admissions remain individually retryable and successful admissions are not duplicated.
- [x] Resolve per-Agent native model choices against that runtime's catalog; retain each Agent's existing model/effort/permission controls.
- [x] Show a compact upward recipient picker in the composer; retain attachment/goal/permissions/model/send positions and responsive mobile sizing.
- [x] Update tab status from events and lightweight queue snapshots. Preserve conversation drafts across result-tab switches.

### Task 4: Behavioral regression checks and responsive verification

**Files:** focused tests beside the group service/store, gateway, dispatch helpers and new components.

- [x] Cover independent native cwd creation, unvisited runtime directory, rollback, persistent lookup, selected recipient fan-out, partial send failure and retry without duplicate successful sends.
- [x] Cover model/effort queue preservation and existing single-Agent behavior.
- [x] Inspect mobile 320/390 and desktop UI using ego-browser, with no changes to the existing content renderer.

## Final Unit Test Verification

- [x] Main agent: run the new group/store/dispatch/component tests and existing composer, queue, gateway, and broker tests after development is complete.
- [x] Run WebApp/Desktop TypeScript checks and WebApp production build. Fix failures caused by this change; report independent baseline failures accurately.
- [x] Review the scoped diff, update the wiki findings, and report implementation/verification separately from deployment.


## Verification record

- 13 focused suites: 227 tests passed, including 120 broker regressions. The subsequent Customer Agent profile assertion also passed (4 run-option tests, one newly added), for 228 distinct passing tests.
- Core and native-runtime package builds passed. WebApp production output is staged at `/private/tmp/agentroam-parallel-preview/dist`.
- Ego TaskSpace 65 used the actual ChatView with simulated runtime ports: create/fan-out, targeted sends while viewing another Agent, per-Agent model/effort, draft preservation, reload recovery, partial failure and receipt-preserving retry all checked.
- Mobile 320px has no horizontal overflow; tabs measure 56x44px. The settings panel stays within x=16..304px. 390px and desktop layouts were also inspected. Screenshots are in `.artifacts/parallel-agent-qa/`.
- Default WebApp/Desktop type checks remain blocked by pre-existing workspace errors (SQLite ambient types, TS library/path configuration, client-error-reporter, and existing renderer errors). New parallel feature files have no remaining diagnostics in the Desktop run.
- The temporary 5177 fixture server was stopped and its source moved out of the repository; no real Agent prompts were submitted and port 3000 was not restarted by this task.
- Target/loop commands retain their existing single-Agent semantics: select only the currently viewed participant before using them.
