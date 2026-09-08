# Codex Independent Execution Rows Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve per-turn and per-tool lazy loading while restoring separate Chinese reasoning and tool rows after a Codex trace is available.

**Architecture:** Keep `CodexExecutionTrace` as the per-turn request, cache, revision, and retry owner. Render only a compact load action for an untouched historical turn; render `CodexExecutionTraceContent` directly for live or loaded data, and group only consecutive same-action tools inside the ordered trace.

**Tech Stack:** React 18, TypeScript, Vitest, React DOM server rendering, existing `ReasoningSummary` and `ToolCallCard` components.

## Global Constraints

- Opening Codex history must still load only the core page.
- Historical trace metadata loads only after `查看执行过程` is clicked.
- Live reasoning, commentary, and tool events display immediately without a click.
- Tool result bodies continue to load only when their individual tool row is expanded.
- Loaded trace contents have no outer `执行过程` disclosure.
- Adjacent same-action tool calls use the existing local tool group.
- Claude Code, OpenCode, Customer Agent, and backend history protocols remain unchanged.

---

### Task 1: Direct Loaded And Live Trace Rendering

**Files:**
- Modify: `packages/desktop/renderer/components/CodexExecutionTrace.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`
- Unit tests: `packages/desktop/renderer/components/CodexExecutionTrace.test.tsx`

**Interfaces:**
- Consumes: `trace.liveMessages`, `loadTrace(trace)`, `refreshSignal`, and the existing lazy `loadToolResult(ref)` callback.
- Produces: an unloaded `查看执行过程` action or direct `CodexExecutionTraceContent` rows.

- [x] **Step 1: Replace the outer disclosure state with data availability**

Remove the `expanded` toggle and item-count summary. Keep `messages: ChatMessage[] | null` as the historical load sentinel and compute:

```ts
const liveMessages = trace.liveMessages ?? [];
const hasMessages = messages !== null || liveMessages.length > 0;
```

If `hasMessages` is true, render `CodexExecutionTraceContent` directly inside the stable turn container. If it is false, render one button whose visible label is `查看执行过程`, `正在加载执行过程`, or `重新加载执行过程` according to request state. Add an `autoLoad?: boolean` prop and have `ChatView` set it only when this is the latest trace and the selected session is running, so current Codex Desktop commentary is fetched without making older turns eager.

- [x] **Step 2: Preserve request, retry, cache, and refresh behavior**

The historical action calls the existing deduplicated loader once:

```tsx
onClick={() => void ensureLoaded().catch(() => undefined)}
```

When `autoLoad` is true and no live or loaded message exists, call the same deduplicated loader from an effect. Keep loaded messages mounted and reusable. Change the independent refresh effect to refresh only when process rows are already visible or the current running turn is explicitly auto-loaded:

```ts
if ((!hasMessages && !autoLoad) || refreshSignal === 0) return;
if (handledRefreshSignalRef.current === refreshSignal) return;
handledRefreshSignalRef.current = refreshSignal;
void ensureLoaded(true).catch(() => undefined);
```

- [x] **Step 3: Update trace loading styles**

Reuse the compact summary row styling for `codex-execution-trace__load`, remove chevron rotation and outer body rules, and keep the loading icon animation keyed by `aria-busy="true"`. Direct timeline rows retain the current full-width alignment and spacing.

- [x] **Step 4: Update focused component tests**

Assert that server rendering an untouched history trace renders `查看执行过程`, has no trace request, and has no timeline. Assert that live messages render `终端` and their command preview immediately without the load action or trace request. Keep commentary and refresh source-contract coverage, updated for `hasMessages` instead of `expanded`.

### Task 2: Adjacent Tool Groups

**Files:**
- Modify: `packages/desktop/renderer/components/CodexExecutionTrace.tsx`
- Unit tests: `packages/desktop/renderer/components/CodexExecutionTrace.test.tsx`
- Unit tests: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: coalesced execution messages and existing tool metadata (`beforeContent`, runtime progress, native subagent activity).
- Produces: ordered standalone `ToolCallCard` elements or local `ToolCallGroup` elements for consecutive same-action calls.

- [x] **Step 1: Restore trace-local adjacent grouping**

Keep `coalesceAdjacentToolCallMessages(messages)` so split records for the same assistant carrier remain stable. Pass each row's tool entries through `groupAdjacentToolCallEntries`; render groups with more than one same-action item through `ToolCallGroup`, otherwise render the single `ToolCallCard` directly.

```tsx
{toolEntries.map(({ toolCall, beforeContent, progress, nativeSubagent }) => (
  <ToolCallCard
    key={toolCall.id}
    toolCall={toolCall}
    beforeContent={beforeContent}
    progress={progress}
    nativeSubagent={nativeSubagent}
    onSelectSession={onSelectSession}
    workspacePath={workspacePath}
    enableFilePreview={enableFilePreview}
    onLoadResult={onLoadResult}
  />
))}
```

Use the same grouping helper for Codex fallback entries in `ChatView`, matching other agents without changing their behavior.

- [x] **Step 2: Add a multiple-terminal regression**

Server-render `CodexExecutionTraceContent` with two adjacent `shell` calls. Assert the markup contains one `tool-call-group` summary with `终端` and `2 项`, while no outer execution disclosure returns. Add a source contract asserting that Codex fallback messages use the existing grouping helper.

- [x] **Step 3: Update style contract assertions**

Change the Codex trace style assertions to require the compact load action and direct timeline rules. Keep the existing assertion that ordinary `ChatView` still uses `groupAdjacentToolCallEntries(toolCallEntries)`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec vitest run \
  packages/desktop/renderer/components/CodexExecutionTrace.test.tsx \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts \
  packages/desktop/renderer/lib/codex-execution-trace.test.ts
```

Expected: PASS

Then run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec tsc -p packages/desktop/tsconfig.json --noEmit
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec tsc -p packages/webapp/tsconfig.json --noEmit
git diff --check
```

Expected: all commands exit successfully.

If a test or type check fails, fix the implementation or test and rerun the failing command until it passes. Report the exact commands and results in the final response.
