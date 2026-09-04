# Native Turn-Boundary History Deduplication Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent completed native Agent turns from appearing twice after the WebApp refreshes persisted history.

**Architecture:** Paginate the fully reconciled native transcript on user-turn boundaries, treating `limit` as a soft target and encoding the adjusted start in the existing cursor. Merge refreshed history by anchoring on the included user message so one live turn is replaced by one persisted turn without global text deduplication.

**Tech Stack:** TypeScript, Vitest, Electron renderer utilities, native runtime broker, Bun.

## Global Constraints

- Keep the opaque `history.v1.<offset>` cursor format unchanged.
- Reconcile the complete native transcript before applying pagination.
- Preserve `_nativeRunId + _nativeSequence` event replay protection.
- Preserve tool-result attachment, queued messages, and legacy assistant-only history.
- Do not globally deduplicate messages by text.
- Preserve unrelated changes in the dirty worktree.

---

### Task 1: Turn-Boundary Session Pagination

**Files:**
- Modify: `packages/core/src/domain/session/SessionHistory.ts`
- Unit tests: `packages/core/src/domain/session/SessionHistory.test.ts`

**Interfaces:**
- Consumes: `paginateSessionHistory(messages: Message[], events: AgentEvent[], query?: SessionHistoryQuery): SessionHistoryPage`
- Produces: the same public function and cursor contract, with page starts rewound to a preceding user message when the nominal start splits a turn.

- [x] **Step 1: Add focused pagination tests**

Add cases that construct a turn with more visible messages than the requested limit and assert that the page begins with its user input, `pageSize` reflects the expanded page, and `nextCursor` uses the adjusted start. Add coverage that the older page has no gap or overlap, tool results remain attached, and an assistant-only prefix starts at zero when no user boundary exists.

- [x] **Step 2: Resolve a safe page start**

Implement a private helper with this behavior:

```ts
function findTurnBoundaryStart(messages: Message[], nominalStart: number): number {
  if (nominalStart <= 0 || messages[nominalStart]?.role === "user") return nominalStart;
  for (let index = nominalStart - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return 0;
}
```

Use the adjusted start for slicing, `nextCursor`, `hasMore`, and the returned `pageSize`; keep the original exclusive `end` unchanged.

- [x] **Step 3: Preserve existing paging semantics**

Confirm invalid cursor fallback, page-size clamping, event selection, and tool-result lookup remain unchanged outside the adjusted boundary.

### Task 2: Renderer Turn Replacement

**Files:**
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Unit tests: `packages/desktop/renderer/lib/session-history.test.ts`

**Interfaces:**
- Consumes: `mergeRefreshedSessionHistory(current: ChatMessage[], refreshed: ChatMessage[]): ChatMessage[]`
- Produces: the same function, aligning a refreshed complete turn to the nearest matching user boundary before comparing exact message representations.

- [x] **Step 1: Add live-versus-persisted reconciliation tests**

Add a case where the current live turn and refreshed persisted turn share the user input but group tool calls differently, then assert only one final assistant response remains. Add a separate case with identical text in distinct turns and assert both turns remain.

- [x] **Step 2: Prefer a user boundary anchor**

Find matching user messages between the refreshed page and current history, choose the candidate nearest the expected latest-page start, and use that ordered boundary as the replacement start. Retain exact contiguous matching as the fallback for legacy assistant-only pages, and retain the existing expected-tail fallback when no overlap exists.

- [x] **Step 3: Preserve stable local presentation state**

Keep existing IDs, timestamps, optimistic images, persisted attachments, and queued-message placement for exact matched rows. Do not remove unrelated messages solely because their text matches.

### Task 3: Native Broker Regression Coverage

**Files:**
- Unit tests: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

**Interfaces:**
- Consumes: native host `get(sessionId, query)` and its existing full-transcript projection path.
- Produces: regression proof that retained run projection is reconciled before turn-boundary pagination.

- [x] **Step 1: Extend the existing pagination regression**

Create a native history where one user turn spans more than the requested page limit and retained events represent that same completed run. Assert the latest page includes the user boundary and exactly one final response.

- [x] **Step 2: Verify cursor continuity through the broker**

Load the preceding page using the returned `nextCursor` and assert the two pages cover the transcript without conversational overlap or a synthesized duplicate `__native_run:<runId>` input.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/core/src/domain/session/SessionHistory.test.ts \
  packages/desktop/main/agent-runtime/native-runtime-broker.test.ts \
  packages/desktop/renderer/lib/session-history.test.ts \
  packages/server/app/api/native-runtime.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts
bunx tsc -p packages/desktop/tsconfig.json --noEmit
bunx tsc -p packages/webapp/tsconfig.json --noEmit
git diff --check
```

Expected: all focused Vitest suites pass, both TypeScript checks exit successfully, and `git diff --check` reports no whitespace errors.
