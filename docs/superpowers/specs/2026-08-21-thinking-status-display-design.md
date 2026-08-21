# Thinking Status Display Design

## Goal

Make the active agent state understandable without exposing internal loop diagnostics. While the model is preparing its next response, the chat should show only `思考中`; existing tool-call cards remain visible and continue to show what ran, its arguments, status, and result.

## Current Problem

`AgentLoop` emits `thinking` events for internal progress such as `Iteration 3...`, retry, and context compaction. `ChatView` accumulates every event message into `thinkingText` and renders it in a bordered `思考过程` block. This makes an ordinary wait between a completed tool call and the next model response look like a stalled reasoning trace.

The screenshot does not by itself indicate a deadlock. The tool card completed, and runtime logs show the same run later reached TTS. Network errors can still make a model request wait temporarily, but the raw iteration label is only an internal diagnostic.

## Design

### User-Facing Status

- Model wait, retry, iteration, and context compaction all render as the same lightweight `思考中` indicator with animated dots.
- Active tool execution renders as `工具执行中`.
- The indicator is cleared on completion, cancellation, or error.
- No raw `thinking` event message is rendered in the conversation.

### Tool Visibility

- Preserve the current independent tool-call cards.
- Preserve tool name, arguments, running/completed/failed state, result content, and expand/collapse behavior.
- Do not add a separate tool dashboard or summary panel.
- A completed tool card remains in conversation history while the lightweight status changes back to `思考中` for the next model iteration.

### Implementation Boundary

The renderer will treat `thinking` events as state transitions instead of display content. `AgentLoop` may continue emitting its current diagnostic messages because they can remain useful to non-visual consumers and logs. This keeps the behavior change scoped to presentation and avoids changing the agent execution protocol.

The two existing thinking placements in `ChatView` will share the same status-only visual treatment:

- before the first assistant response;
- above the latest streaming assistant response after a tool call.

The bordered `思考过程` mini-card, italic diagnostic text, and `thinkingText` accumulation will be removed.

## State Flow

1. A run starts: show `思考中`.
2. The model requests a tool: show the existing tool card and `工具执行中` while it runs.
3. The tool finishes: retain the completed tool card and show `思考中` while the model continues.
4. Text streams: keep the normal assistant response presentation without exposing internal diagnostics.
5. The run completes, is cancelled, or fails: clear the activity indicator.

## Error Handling

Existing error and cancellation behavior remains authoritative. This change does not reinterpret timeouts as success and does not hide tool failures; failed tools continue to show their failure state in their tool cards.

## Verification

- Add focused renderer coverage for `thinking` events so raw messages such as `Iteration 3...` cannot become visible UI text.
- Verify transitions `思考中` -> `工具执行中` -> `思考中` -> cleared.
- Confirm completed and failed tool cards remain visible with their details.
- Build the desktop renderer.
- Inspect the running desktop UI in the supported themes and narrow layout, confirming the indicator is aligned and no `Iteration N...` text appears.

## Non-Goals

- Changing model, tool, retry, or compaction execution behavior.
- Adding a reasoning transcript or expandable chain-of-thought view.
- Adding a separate tool activity dashboard.
- Diagnosing or changing the independent TTS timeout observed in runtime logs.
