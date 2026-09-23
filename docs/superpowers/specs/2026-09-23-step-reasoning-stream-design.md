# Step Reasoning Stream Design

## Goal

Make reasoning from OpenAI-compatible models such as Step 5 Preview visible in Customer Agent's existing collapsible reasoning area, while preventing reasoning-only or token-truncated responses from being recorded as successful empty answers.

## Scope

This change applies to the OpenAI-compatible streaming provider, the shared AgentLoop event bridge, and Customer Agent session projection. It reuses the existing desktop `reasoning_summary_delta` rendering and does not add a new desktop component or mix reasoning into assistant answer text.

## Stream Contract

`StreamEvent` gains a `reasoning_delta` variant containing a text delta. `OpenAIProvider` reads the compatible API field `choices[0].delta.reasoning_content` and emits it separately from `delta.content`.

Reasoning fragments are buffered inside the provider and flushed when either condition is met:

- the buffer reaches 256 characters;
- 150 milliseconds have elapsed since the previous flush.

The provider also flushes buffered reasoning immediately before emitting answer text, a tool call, a terminal error, or `text_done`. This bounds UI update frequency without delaying transitions from reasoning to visible answer or tool activity.

## Agent Event Mapping

`AgentLoop` maps each model `reasoning_delta` event to the existing `reasoning_summary_delta` agent event. Each model request iteration receives one stable `itemId`, and all reasoning deltas from that request use section index `0`.

Reasoning is visible progress, but it is not semantic completion. Only non-empty answer text or a tool call counts as model output for successful completion. Therefore:

- reasoning followed by answer text succeeds normally;
- reasoning followed by a tool call continues the ReAct loop normally;
- reasoning-only `stop` follows the existing empty-stream retry once, then fails if still empty;
- reasoning-only `length` fails immediately as truncation and is not retried.

## Truncation And Error Semantics

Any OpenAI-compatible response with `finish_reason: "length"` emits an error, regardless of whether a tool call is pending. If a tool call is pending, the error continues to identify incomplete tool arguments. Otherwise, the error explains that the model exhausted its output-token allowance before producing a complete answer and recommends increasing the output-token limit or reducing the task.

After emitting a truncation error, the provider does not emit `text_done` and does not flush incomplete tool calls as executable calls. `AgentLoop` consequently emits an `error` followed by terminal `done` for stream compatibility, but it does not checkpoint the iteration as completed. `AgentHost` observes the error first and commits the run with status `failed`.

## Session Persistence

`AgentHost.projectMessagesFromEvents()` merges `reasoning_summary_delta` events into the same assistant message presentation used for answer text:

```ts
presentation: {
  reasoning: [{ itemId, sectionIndex, text }],
}
```

If reasoning arrives before answer text, projection creates an assistant message with empty content and attaches later answer deltas to it. A failed reasoning-only run retains that assistant message and its reasoning presentation so the user can inspect what happened after refresh. Reasoning never becomes `Message.content` and is never sent back to the model as conversation text.

## UI Behavior

The desktop renderer already consumes `reasoning_summary_delta`, merges sections, and renders them through `ReasoningSummary`. The completed implementation therefore uses the existing collapsed "思考中/思考" interaction and requires no new visible control.

During a Step response, the user sees incremental reasoning progress. When answer text begins, it appears in the normal assistant body. Refreshing the session preserves both the reasoning presentation and answer text.

## Testing

Focused provider tests cover:

- parsing and ordered flushing of `reasoning_content` separately from answer content;
- flushing buffered reasoning at stream completion;
- `finish_reason: "length"` without tools producing a truncation error and no `text_done`;
- `finish_reason: "length"` with partial tool arguments producing an error and no tool call.

Focused AgentLoop tests cover:

- mapping reasoning to one stable `reasoning_summary_delta` item per request;
- reasoning plus answer succeeding;
- reasoning-only output retrying once and then failing;
- provider truncation failing without a completed checkpoint.

Focused AgentHost tests cover:

- reasoning and answer text persisting on one assistant message;
- reasoning-only failure persisting the reasoning presentation while the session remains `failed`.

Verification runs only the affected Vitest files first, then the core and server type/build checks used by the repository. A live Step 5 Preview regression should confirm that reasoning appears before the final answer and that a deliberately small output-token limit surfaces truncation instead of an empty completed response.

## Non-Goals

- Exposing hidden chain-of-thought from providers that do not return `reasoning_content`.
- Showing reasoning inside the final answer body.
- Changing reasoning-effort settings or the configured Step output-token limit.
- Adding a separate polling timer or synthetic reasoning text in the desktop UI.
