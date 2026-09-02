# Claude Subagent Live Follow Design

## Goal

Keep Claude Code background subagents alive after the main turn returns and let AgentRoam users watch their public work inside the originating `Agent` tool card on Desktop and Web.

## Current Failure

- Claude Code can return a successful `Agent` tool result immediately when `run_in_background: true`, while the spawned subagent continues independently.
- `ClaudeRuntimeAdapter.run()` currently treats the first main-thread `result` as the end of the native run, breaks the SDK iterator, and closes the query.
- The renderer treats Claude's native `Agent` as an ordinary completed tool because it only has special lifecycle handling for Customer Agent's `dispatch_agent`.
- A reproduced child transcript stopped after four tool calls and three tool results, with no final assistant response, when the host closed the query.

## Approaches Considered

### Force every Claude subagent into the foreground

This is the smallest change, but it removes valid background behavior and still provides no durable nested transcript. It is retained only as a temporary user workaround.

### Flatten subagent messages into the parent timeline

The current adapter could emit forwarded child tool calls as ordinary parent messages. This exposes activity quickly, but loses which `Agent` invocation owns each item, interleaves concurrent subagents, and cannot restore a coherent child view after refresh.

### Maintain a nested native-subagent projection

This is the selected design. SDK task lifecycle events keep the native run alive and maintain status. Forwarded child messages are correlated by `parent_tool_use_id` and rendered inside the matching `Agent` card. Claude's persisted subagent transcript restores the same projection after refresh.

## Runtime Protocol

The Claude query enables:

- `forwardSubagentText: true`, so child assistant/user frames include `parent_tool_use_id` and can form a nested transcript.
- `agentProgressSummaries: true`, so long-running tasks can expose the SDK's short public `task_progress.summary` approximately every 30 seconds.

Private reasoning remains excluded. `thinking` blocks and `thinking_delta` frames are discarded even when they originate from a subagent.

The adapter tracks non-ambient task lifecycle state from:

- `task_started`: register a task, its `task_id`, optional spawning `tool_use_id`, description, agent type, background state, and spawn depth.
- `task_progress`: update description, public summary, last tool, usage, and elapsed time.
- `task_updated`: update running or terminal status and error information.
- `task_notification`: finalize completed, failed, or stopped tasks and capture the final public summary.

The main-thread SDK `result` is retained as the main response result but is not sufficient to end the native run while a registered non-ambient background task remains active. The adapter continues consuming the SDK iterator until those tasks reach a terminal state or the run is explicitly aborted. It then emits one `done` or `error` event and closes the query. If the SDK stream ends while tracked tasks are still active, the run fails with a native protocol error instead of showing false completion.

## Domain Projection

Add a display-safe native subagent projection to the shared domain:

```ts
interface NativeSubagentActivity {
  taskId: string;
  parentToolCallId: string;
  agentName?: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  isBackgrounded?: boolean;
  spawnDepth?: number;
  summary?: string;
  lastToolName?: string;
  elapsedSeconds?: number;
  toolUses?: number;
  messages: Message[];
}
```

Native subagent events carry a complete updated projection rather than renderer-specific incremental mutations. Broker replay therefore remains idempotent, and Desktop/Web consume the same event contract.

Streaming child frames are converted as follows:

- Public `text` blocks append to the nested assistant message.
- `tool_use` blocks append nested tool calls.
- Matching `tool_result` blocks complete nested tool calls.
- Thinking blocks are dropped.
- Frames without `parent_tool_use_id` keep their existing parent-session behavior.

The renderer stores activities by session and `parentToolCallId`. A lifecycle update replaces the matching activity. It does not create a top-level session, trigger Customer Agent child-session discovery, or expose native identifiers in visible copy.

## History Recovery

Claude history loading uses `listSubagents(parentSessionId)` and `getSubagentMessages(parentSessionId, agentId)` for each child transcript. The sibling `agent-<id>.meta.json` supplies the original parent `toolUseId`, description, and agent type needed for correlation.

Recovered child messages pass through the same public-content normalizer used for live events. Incomplete transcripts remain `running` only while the native broker still owns an active task; otherwise they render as `stopped` so stale history never shows an endless spinner.

Pagination of the parent timeline remains unchanged. Only subagents whose parent `Agent` tool call is present in the returned page are attached to that page's presentation metadata.

## User Interface

Claude's native `Agent` card gains the same compact lifecycle semantics on Desktop and Web without reusing `dispatch_agent` session controls:

- Header: `Agent`, subagent type when available, task description preview, and running/completed/failed/stopped status.
- Running cards expand automatically after their first visible child event.
- Expanded body: public progress summary followed by nested public text and tool-call rows in receive order.
- Completed cards remain expandable and show the final summary.
- No “查看子会话” button is shown because the child is not a top-level resumable AgentRoam session.
- Empty or very short work still has a stable-height status row and cannot produce the large blank card shown by the failure case.

## Error And Interruption Behavior

- Explicit stop interrupts the query and marks active child projections as `stopped`.
- Child task failure marks only that card failed; the parent run emits an error only when Claude reports the overall main run as failed.
- Missing or malformed metadata skips history attachment for that child and does not break parent history loading.
- Ambient/housekeeping tasks are ignored in inline activity.
- Concurrent child tasks remain isolated by their parent tool call ID.

## Verification

- Adapter tests cover foreground and background lifecycle ordering, delayed task completion after main `result`, stream termination with active tasks, abort, summary progress, child text/tool filtering, and raw thinking rejection.
- History tests cover metadata correlation, nested transcript recovery, malformed metadata, and incomplete child status.
- Store and renderer tests cover idempotent replacement, concurrent cards, auto-expand, lifecycle labels, nested tool results, and absence of top-level child-session controls.
- Server/Web tests verify that broker replay and SSE preserve native-subagent events.
- Run focused Vitest suites, Core/Desktop/Web/Server type checks, and production builds for Desktop and Web.

## Non-Goals

- Displaying raw Claude thinking or hidden reasoning.
- Sending messages directly to a Claude child agent.
- Promoting Claude child transcripts into top-level AgentRoam sessions.
- Adding equivalent Codex subagent rendering in this change.
