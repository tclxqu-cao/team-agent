# TUI Live Progress and Latency Design

## Goal

Make every TUI turn visibly responsive from submission through completion and remove the avoidable model call that delays ordinary TUI requests. The interface should expose concise lifecycle progress and tool activity without displaying model chain-of-thought.

## Current Problem

`AgentLoop` emits `thinking` before each model iteration and emits `tool_call` and `tool_result` around tool execution. The TUI renders tool events but drops every `thinking` event, so it remains blank until the model produces text or finishes assembling a tool call.

There is also avoidable latency before the first iteration. When no skill trigger matches, `SkillRegistry` asks the model to perform semantic skill matching. A new `AgentBuilder` is created for every TUI turn, and the TUI has no way to disable this fallback. A local timed run measured:

- agent build complete: 12 ms;
- first `thinking` event: 2.35 s;
- first tool call: 4.84 s;
- completed answer: 6.50 s.

The first 2.35 seconds were spent before the visible agent iteration, primarily in semantic skill matching. Tool events were produced correctly once the model requested a tool.

## Design

### Core Configuration

- Add an `AgentBuilder` option that controls LLM-based semantic skill matching.
- Keep semantic skill matching enabled by default so Desktop, Server, SDK, and existing callers retain their current behavior.
- Pass the option into `SkillRegistry`; when disabled, matching uses existing keyword triggers and explicit `/skill-name` activation only.
- Apply the enabled-skill allowlist before semantic matching so an empty effective skill set cannot cause an unnecessary model request.
- Do not change tool registration, tool execution, or the `AgentEvent` protocol.

### TUI Agent Lifecycle

- Build one agent instance during TUI startup and reuse it for sequential turns.
- Configure that agent with semantic skill matching disabled.
- Continue using the same working directory, session store, model configuration, built-in tools, and synchronous `ask_user` tool.
- Reusing the agent avoids repeated discovery and preserves internal caches. `AgentLoop.run()` already resets its abort controller for each turn, so a later turn remains usable after a completed or cancelled turn.

### Live Progress Rendering

- Start a single in-place status line as soon as a non-command message is submitted.
- Render lifecycle states using concise Chinese labels and elapsed time:
  - initial setup: `准备上下文`;
  - `thinking` iteration: `思考中 · 第 N 轮`;
  - retry: `重试中`;
  - compaction: `整理上下文`;
  - active tool: `执行工具 · <name>`.
- Refresh elapsed time without appending repeated lines to terminal scrollback.
- Clear the status line before printing streamed assistant text, a tool call, a tool result, an error, or the next prompt.
- Preserve the existing visible tool-call argument summary and tool-result summary.
- Print a compact total elapsed duration when the turn completes.
- Never render raw model reasoning or use `thinking.message` as unrestricted user-facing content. Only recognized lifecycle messages are mapped to fixed labels; unknown `thinking` messages use the generic `思考中` label.

## Event Flow

1. The user submits a message and the TUI immediately shows `准备上下文`.
2. Keyword and explicit skill matching run locally; semantic matching is skipped for TUI.
3. On `thinking`, the status changes to the appropriate fixed lifecycle label.
4. On `tool_call`, the status line is cleared, the existing tool-call summary is printed, and tool execution status begins.
5. On `tool_result`, the status is cleared and the existing result summary is printed.
6. On a subsequent `thinking`, the TUI shows the next iteration state.
7. On the first text chunk, the status is cleared and text streams normally.
8. On completion, cancellation, or failure, timers and status output are cleared before the prompt is restored.

## Error and Cancellation Handling

- Errors remain visible using the existing error rendering.
- `Ctrl+C` aborts the active agent, clears the status line and timer, prints the interruption notice, and restores the prompt once.
- Status cleanup is idempotent so overlapping `done`, error, and `finally` paths cannot leave timer output after the prompt.
- A failed agent build exits through the existing turn error path and still clears progress state.

## Testing

- Add focused core tests proving semantic matching remains enabled by default and is not called when explicitly disabled.
- Add a test proving the enabled-skill filter prevents semantic matching when no allowed skills remain.
- Extract the TUI status formatting and state handling into an import-safe module and test:
  - known and unknown `thinking` messages;
  - tool-call and tool-result transitions;
  - first text clearing the status;
  - completion, error, and cancellation cleanup;
  - elapsed-time formatting.
- Run the focused tests, the core test suite, and the project type check.
- Run the TUI against the configured local provider with a harmless forced `pwd` tool call and confirm progress appears before the first model response, tool details remain visible, and the prompt returns cleanly.

## Non-Goals

- Exposing chain-of-thought or raw hidden reasoning.
- Disabling semantic skill matching outside the TUI.
- Changing model-provider streaming formats or timeout policy.
- Redesigning the TUI conversation layout, session commands, or tool output truncation limits.
- Changing the Desktop or web progress presentation.
