# Native Runtime Reasoning Summary And Progress Design

## Goal

Show meaningful transitions while native Claude Code and Codex turns are running without exposing private chain-of-thought. Codex publishes readable reasoning summaries when its app-server protocol provides them. Claude Code publishes token, tool, retry, and public status progress. The Web and Desktop surfaces render the same normalized stream and recover correctly after reconnecting.

## Scope

- Add normalized reasoning-summary and runtime-progress events to the shared agent contract.
- Map approved Claude Agent SDK and Codex app-server notifications into that contract.
- Render live status without appending high-frequency message rows.
- Persist and restore public Codex reasoning summaries.
- Keep transient progress replayable while the broker retains a run, then remove it from the durable conversation projection.
- Rebuild and restart the production Web instance on port 3000 after verification.

Raw Claude `thinking` blocks and Codex `item/reasoning/textDelta` notifications are explicitly out of scope and must never enter the shared event or renderer state.

## Normalized Event Contract

Add two `AgentEvent` variants:

```ts
type ReasoningSummaryDeltaEvent = {
  type: "reasoning_summary_delta";
  itemId: string;
  sectionIndex: number;
  delta: string;
};

type RuntimeProgressEvent = {
  type: "runtime_progress";
  progressId: string;
  phase: "thinking" | "tool" | "retry" | "status";
  label: string;
  detail?: string;
  toolCallId?: string;
  elapsedSeconds?: number;
  current?: number;
  total?: number;
};
```

`itemId + sectionIndex` identifies a persistent summary section. `progressId` identifies a replaceable live status slot. A repeated progress event with the same id replaces its predecessor; it never appends another chat message.

Extend `MessagePresentation` with normalized reasoning sections so native history and live projection use one renderer contract:

```ts
interface ReasoningSummarySection {
  itemId: string;
  sectionIndex: number;
  text: string;
}

interface MessagePresentation {
  rawContent?: string;
  attachments?: MessageAttachment[];
  reasoning?: ReasoningSummarySection[];
}
```

Reasoning presentation is display-only and is never sent back to a model by Customer Agent's provider abstraction.

## Runtime Mapping

### Codex

The Codex adapter maps:

- `item/reasoning/summaryTextDelta` to `reasoning_summary_delta` using `itemId`, `summaryIndex`, and `delta`.
- `item/reasoning/summaryPartAdded` to a zero-content section boundary only when the section does not yet exist.
- `item/started` tool items to the existing `tool_call` plus an initial associated `runtime_progress` when useful.
- turn/item status notifications that have stable public wording to `runtime_progress`.

The adapter ignores `item/reasoning/textDelta` unconditionally. It also ignores malformed summary notifications without a string item id, nonnegative integer section index, or string delta.

`codexTurnsToMessages` converts native `reasoning` items' `summary` array into an assistant message whose `presentation.reasoning` contains one section per summary entry. The raw `content` array is ignored. This makes refresh history match the live stream without storing a second copy outside Codex.

### Claude Code

The Claude adapter maps these public SDK events:

- `system/thinking_tokens` to thinking progress with the running estimated token count.
- `tool_progress` to tool progress keyed by `tool_use_id`, including elapsed seconds.
- `system/api_retry` to retry progress with attempt and retry-limit information when present.
- `system/informational`, `system/status`, hook progress, and task progress only when their SDK fields contain public user-facing status text.

Claude assistant `thinking` blocks and streaming `thinking_delta` content are ignored. Claude does not emit `reasoning_summary_delta` unless a future SDK version adds an explicit public-summary message; the adapter must not reinterpret private thinking as a summary.

## Broker And Replay

The broker continues assigning a durable run-local sequence to every normalized event. This preserves SSE and Desktop reconnect semantics without changing the transport.

`reasoning_summary_delta` events participate in the live message projection. Deltas with the same `itemId + sectionIndex` concatenate in sequence order. Duplicate broker events are ignored by the existing run-id plus sequence guard.

`runtime_progress` events remain in the retained broker event log so a refresh during an active or recently completed run can reconstruct the latest status. Projection and renderer code reduce them by `progressId`, keeping only the latest value. A terminal `done` or `error` clears the live progress map. Progress does not become a `Message` and is not copied into native history.

The existing broker terminal retention window may retain raw progress events briefly for reconnect safety. This is transport retention, not conversation persistence. Once the broker run expires, native history remains the source of truth and only Codex public reasoning summaries survive.

## Renderer Behavior

`ChatView` maintains runtime progress per session separately from chat messages.

- A global progress row appears below the active assistant content when the latest event is not associated with a tool.
- Tool-associated progress updates the matching tool row's status label and elapsed time.
- The row uses stable geometry and replaces its text in place; token or elapsed updates cannot add DOM rows or move surrounding content.
- Progress is announced through a throttled polite live region so high-frequency token updates do not flood screen readers.
- `done` and non-preserved `error` clear progress.

Reasoning summaries render as an unframed collapsible row labeled `思考摘要`:

- expanded while deltas are arriving;
- collapsed by default after the run completes or when restored from history;
- ordered by summary section index;
- rendered through the existing safe Markdown path;
- visually distinct from assistant final text and tool-call rows without becoming a nested card.

Claude turns with no public summary do not render an empty summary row. Their token/tool/retry status disappears on completion, leaving the tool calls and final public answer as the durable transcript.

## Error Handling

- Unknown native events remain ignored for forward compatibility.
- Malformed normalized fields are rejected at the adapter boundary rather than reaching the renderer.
- Out-of-order Codex section deltas create the identified section and are sorted by `sectionIndex` at render time.
- A duplicate or replayed event cannot duplicate summary text because the broker sequence guard runs before applying the delta.
- Runtime progress never changes run terminal state, approval state, or occupancy locks.
- Summary rendering failure falls back to plain text and must not terminate the native run.

## Testing

Focused tests must prove:

1. Claude maps thinking-token, tool-progress, retry, and public status messages, and never maps thinking blocks or thinking deltas.
2. Codex maps summary deltas and boundaries, ignores raw reasoning deltas, and restores only native summary fields from history.
3. Broker replay preserves normalized events, projection merges reasoning deltas, progress reduces by id, and terminal events clear live progress without removing summaries.
4. Renderer state merges summary sections without duplication, associates tool progress with the correct row, restores collapsed summaries, and clears transient progress on terminal events.
5. Web SSE and Desktop IPC forward the new event variants without changing their envelopes.
6. Long-running token/progress updates keep a stable number of message rows and produce accessible, throttled status output.

After focused tests and type checks pass, build the server production bundle, ensure the Node 22 `better-sqlite3` ABI is usable, restart the launchd-managed `com.agentroam.customer-agent.webapp`, and verify `/web`, `/api/agent/runtime-health`, and `/api/sessions` return HTTP 200 with a stable PID on port 3000.

## Non-Goals

- Displaying private chain-of-thought or raw reasoning content.
- Synthesizing a Claude reasoning summary from hidden thinking.
- Persisting every token or elapsed-time update as conversation history.
- Changing model reasoning-effort configuration or tool permission policy.
- Refactoring unrelated message, broker, or session code.
