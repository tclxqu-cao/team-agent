# Supervision Group Messages Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show everything the supervisor receives, sends and does in its group's message timeline, including existing saved incidents.

**Architecture:** Store an append-only group-scoped supervision message journal independently from discussion selection and supervision snapshots. Record changed observations, diagnostic exchanges, actual runtime send attempts/receipts, user decisions, configuration actions and incident transitions. Poll and paginate that journal in the group chat and merge it with ordinary discussion messages by timestamp.

**Tech Stack:** TypeScript, SQLite, Next.js route handlers, React, Vitest.

## Global Constraints

- Preserve existing uncommitted collaboration/image/dashboard work in this shared checkout.
- Do not create artificial discussions, send business messages during verification, or alter monitor recovery policy.
- Unchanged polling must not duplicate records. Record attempts and accepted admission separately from verified downstream progress.
- Existing incidents can supply history; do not fabricate unsaved historical exchanges.
- Plans live in `.superpowers/plans/`; project docs and Git commits are outside this request.

### Task 1: Persist the supervision message journal

**Files:** `packages/core/src/domain/supervision/{types,messages}.ts`, `packages/core/src/application/supervision/ports.ts`, `packages/core/src/infrastructure/SQLiteSupervisionRepository.ts`.

**Interfaces:** `SupervisionMessage`, `SupervisionMessagePage`; `appendMessage(message)`, `listMessages(groupId, {afterSequence?, beforeSequence?, limit?})`; `save(state, expectedGeneration?, messages?)` commits snapshot changes and their messages atomically.

- [x] Add typed, timestamped messages with direction, sender, recipient, session identity and optional incident/status.
- [x] Create indexed SQLite storage with unique message IDs, sequential pagination, generation-safe atomic saves and backfill of existing incidents.
- [x] Cover persistence/reopen, deduplication, pagination, isolation and rejected stale saves in SQLite tests.

### Task 2: Record the actual supervision activity

**Files:** `packages/core/src/application/supervision/SupervisionService.ts`, `packages/server/lib/supervision/runtime.ts`, affected supervision tests.

**Interfaces:** Runtime `continue` accepts optional group/sender context for its actual instruction and receipt journal; changed source observations use a content revision for deduplication.

- [x] Journal source context only when changed, and atomically record incident status/message changes.
- [x] Record diagnostic input/output/errors, actual continuation and handoff instructions, admission receipts and failures.
- [x] Record validated user decisions and their outcomes, pause/resume and reapplication of configuration.
- [x] Test normal repeated polling, intervention/verification, user decisions and owner handoff without real business sends.

### Task 3: Show journal entries in the group chat

**Files:** `packages/core/src/domain/collaboration/types.ts`, `packages/server/app/api/collaboration/route.ts`, new `useSupervisionMessages.ts` and `SupervisionMessageItem.tsx`, `CollaborationPage.tsx`, `collaboration.css`.

**Interfaces:** `supervisionMessages` read command; page-based initial/history reads and incremental polling independent of discussion existence.

- [x] Add group validation and bounded journal queries to the route.
- [x] Load/poll supervision messages even when the group has no discussion; support loading older entries and show fetch failures.
- [x] Render sender/recipient, direction, time, source session and complete expandable content in the existing message area.
- [x] Merge ordinary chat and supervision entries chronologically while preserving composer/image/member behavior.
- [x] Test the original empty-discussion trigger, mixed ordering, direction labels and history merging.

## Final Unit Test Verification

- [x] Main agent: run affected supervision core/repository/runtime and collaboration renderer tests after development is complete.
- [x] Build core and WebApp; typecheck the affected packages and build the server when needed for runtime validation.
- [ ] Use ego-browser to confirm the actual no-discussion monitor group displays its saved history and can expand message content. Verify new journal collection with isolated test fixtures, without retrying real business work.
- [x] Review the final diff against the root project instructions, preserve unrelated changes, and update the wiki capture with implementation and acceptance boundaries.

## Execution Evidence

2026-11-02: 51 supervision/renderer tests and 94 native broker tests passed; Core, Native Runtime, Server and WebApp builds passed; focused renderer typecheck passed. Isolated browser verified no-discussion history, live incremental messages, reload persistence and long-content expansion. Local :3000 deployed; API/SQLite evidence in `/tmp/agentroam-supervision-20261102/live-verification.json`. Final real-page browser check is waiting for the user to close an Ego notification permission prompt in task space 44.
