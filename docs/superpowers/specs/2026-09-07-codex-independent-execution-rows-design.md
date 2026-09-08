# Codex Independent Execution Rows Design

## Goal

Restore the earlier Codex execution presentation without giving up the current
core-first history performance model. After execution metadata is available,
the chat timeline shows separate Chinese rows such as `思考`, `终端`, `查阅`,
`写入`, and `工具`. It must not keep those rows inside one expandable
`执行过程` container. Consecutive same-action tool calls remain grouped inside
the sequence so the timeline reads as `思考 / 中文过程 / 工具组 / 中文过程`.

## Display States

### Historical Turns Before Loading

Core history continues to contain only user messages, final answers, and a
stable trace locator for each Codex turn. An unloaded historical turn shows one
compact `查看执行过程` action. Opening a session does not request trace data.

Clicking the action requests only that turn with its current history revision.
While the request is pending, the same row shows a loading state. A failure
keeps the core conversation readable and turns the row into a retry action.

### Historical Turns After Loading

After the trace request succeeds, the loading action is replaced by the trace
contents. There is no outer disclosure or `执行过程 · N 项` summary around the
loaded contents.

Reasoning summaries use the existing `ReasoningSummary` row and retain their
own detail disclosure. Consecutive tool calls with the same action family use
the existing `ToolCallGroup`; a reasoning or commentary row, or a tool from a
different action family, breaks the group. Expanding the group reveals its
individual `ToolCallCard` entries.

Codex public `commentary` text remains in rollout order between reasoning and
tool rows. It is rendered as ordinary secondary process text, while the final
answer remains a top-level assistant message outside the trace.

### Active Turn

When a turn has live reasoning, commentary, or tool events, those events are
shown immediately as ordered rows and local tool groups. The user does not need to click
`查看执行过程` for the currently running turn because the data is already in
renderer memory.

The active turn continues to reconcile live events with trace refreshes by
stable reasoning item and tool-call IDs. A refresh must not duplicate rows or
replace the visible process with an outer summary; adjacent same-action tools
may still use their local group.

## Loading And Performance Boundaries

The existing two-level lazy-loading contract remains authoritative:

1. Opening history loads only the lightweight core page.
2. Clicking `查看执行过程` loads metadata for one turn only.
3. Expanding an individual tool row loads that tool result body only.

Loaded trace metadata is cached for the mounted session revision and concurrent
requests for the same turn remain deduplicated. A revision change invalidates
stale locators without automatically loading untouched turns. Therefore the
change restores the old row-level presentation without restoring the former
page-wide trace request or full hidden DOM.

## Component Boundary

`CodexExecutionTrace` remains the owner of per-turn loading, retry, revision,
and live/snapshot reconciliation. Its render contract changes by state:

- unloaded historical trace: render the compact load action;
- loading or failed historical trace: render status or retry in that row;
- loaded historical trace: render `CodexExecutionTraceContent` directly;
- live trace: render `CodexExecutionTraceContent` directly.

`CodexExecutionTraceContent` renders messages in source order. It may continue
to coalesce adjacent tool-only assistant carriers, then applies
`groupAdjacentToolCallEntries` within that uninterrupted span.
Codex execution events that lack a `turnId` and therefore use the legacy
top-level message fallback use the same adjacent-tool grouping. Other agents
retain their existing grouping behavior. No protocol or server endpoint
changes are required for this presentation change.

## Error Handling

- Trace failure affects only the selected historical turn and provides a retry.
- Tool-result failure affects only that tool row and uses the existing retry.
- Stale revision responses are discarded rather than shown under a newer core
  page.
- Empty traces replace the load action with the existing empty-state text.

## Testing

Focused tests must prove:

- mounting an unloaded historical trace makes no request;
- clicking `查看执行过程` loads exactly one turn and replaces the action with
  the ordered trace rows;
- a live trace displays ordered rows without a click;
- multiple adjacent terminal or same-action tools render as one local
  `ToolCallGroup`, without restoring an outer execution disclosure;
- reasoning and public commentary preserve source order with tool calls;
- loaded traces are reused, refresh safely, and keep lazy tool-result loading;
- loading, empty, and retry labels remain accessible and Chinese;
- non-Codex and ordinary top-level message rendering do not change.

Run the focused renderer tests with Node 22, followed by Desktop and WebApp type
checks and `git diff --check`.

## Non-Goals

- Returning to automatic page-wide trace hydration.
- Loading every historical turn when a session opens.
- Loading tool result bodies before their individual rows are expanded.
- Changing Codex history, SSE, pagination, or tool-result API contracts.
- Changing Claude Code, OpenCode, or Customer Agent presentation.
