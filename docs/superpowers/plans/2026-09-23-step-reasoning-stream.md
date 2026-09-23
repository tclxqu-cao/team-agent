# Step Reasoning Stream Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display Step reasoning in Customer Agent's existing reasoning panel and fail token-truncated or reasoning-only responses instead of recording an empty success.

**Architecture:** Add a provider-level reasoning event that keeps compatible API reasoning separate from answer text. AgentLoop maps that event into the existing public reasoning event while preserving answer/tool-only success semantics, and AgentHost projects those events into durable assistant presentation metadata.

**Tech Stack:** TypeScript, async generators, OpenAI-compatible SSE, Vitest, SQLite-backed session projection

## Global Constraints

- Preserve all unrelated dirty-worktree changes.
- Do not expose reasoning through assistant `Message.content` or send it back as conversation text.
- Reuse the existing `reasoning_summary_delta` renderer; do not add desktop UI controls.
- Treat every `finish_reason: "length"` as a model error.

---

### Task 1: OpenAI-Compatible Reasoning Stream

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts:105`
- Modify: `packages/core/src/domain/model/providers/OpenAIProvider.ts:28`
- Unit tests: `packages/core/src/domain/model/providers/__tests__/OpenAIProvider.test.ts`

**Interfaces:**
- Consumes: OpenAI-compatible SSE `choices[0].delta.reasoning_content` and `choices[0].finish_reason`
- Produces: `StreamEvent` variant `{ type: "reasoning_delta"; text: string }`

- [x] **Step 1: Extend the model stream event contract**

Add the distinct reasoning variant without changing existing provider interfaces:

```ts
export type StreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "text_chunk"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "text_done" }
  | { type: "error"; message: string; code?: string };
```

- [x] **Step 2: Buffer and flush reasoning separately from answer text**

Maintain a provider-local reasoning buffer. Append only string `reasoning_content`, emit a `reasoning_delta` when it reaches 256 characters or 150 ms have elapsed, and flush it before content, tool calls, terminal errors, and normal completion.

- [x] **Step 3: Make output truncation terminal for all response shapes**

When `finish_reason === "length"`, flush reasoning, emit the applicable Chinese truncation error, clear pending tool calls, and suppress both tool-call emission and `text_done`.

- [x] **Step 4: Add focused provider tests**

Use synthetic SSE responses to assert reasoning ordering, completion flush, reasoning-only truncation, and partial-tool truncation.

### Task 2: AgentLoop Reasoning Mapping And Completion Rules

**Files:**
- Modify: `packages/core/src/domain/agent/AgentLoop.ts:376`
- Unit tests: `packages/core/src/domain/agent/__tests__/AgentLoop.test.ts`

**Interfaces:**
- Consumes: `{ type: "reasoning_delta"; text: string }`
- Produces: `{ type: "reasoning_summary_delta"; itemId: string; sectionIndex: 0; delta: string }`

- [x] **Step 1: Allocate one reasoning item identity per model request**

Create the item id before the retry loop so all chunks and an empty-stream retry for the same AgentLoop iteration remain grouped predictably.

- [x] **Step 2: Map reasoning without marking semantic output**

Yield `reasoning_summary_delta` for each provider reasoning event, but leave `streamProducedOutput` unchanged. Answer text and tool calls remain the only successful outputs.

- [x] **Step 3: Preserve failure checkpoint semantics**

Keep the existing empty-stream retry for reasoning-only normal completion. Provider truncation emits `error`, causing AgentLoop to skip the `completed` checkpoint and return a terminal `done` only as stream closure.

- [x] **Step 4: Add focused AgentLoop tests**

Assert stable reasoning identity with answer text, reasoning-only retry/failure, and no completed checkpoint after an error.

### Task 3: Durable Reasoning Projection

**Files:**
- Modify: `packages/server/app/api/agent-host.ts:397`
- Unit tests: `packages/server/app/api/agent-host.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` reasoning deltas and answer events for one run
- Produces: assistant `Message.presentation.reasoning` using `ReasoningSummarySection[]`

- [x] **Step 1: Merge reasoning events into the streaming assistant message**

Create an empty assistant message when reasoning arrives first and merge by `itemId` plus `sectionIndex` using the core `mergeReasoningSummaryDelta()` helper.

- [x] **Step 2: Keep later text on the same assistant message**

Allow subsequent `text_chunk` and `done` events to update the reasoning-bearing assistant message so history contains one assistant entry.

- [x] **Step 3: Add persistence tests**

Assert reasoning plus answer persists on one message, and reasoning-only provider error persists its reasoning while the session status is `failed`.

### Task 4: Runtime Regression

**Files:**
- No product file changes

**Interfaces:**
- Consumes: configured Step 5 Preview model profile
- Produces: observed live reasoning progress and an explicit truncation error rather than an empty completed answer

- [x] **Step 1: Build and restart the affected desktop/web runtime**

Use the repository release/restart workflow so the running Customer Agent loads the new core and server code.

- [x] **Step 2: Run one normal Step request**

Confirm the existing reasoning panel updates before answer content and the persisted session restores both after refresh.

- [ ] **Step 3: Run one constrained-output probe**

Use a low output-token allowance and confirm the session fails with a truncation message instead of `completed` with empty content.

### Task 5: Anthropic And Native Claude Reasoning

**Files:**
- Modify: `packages/core/src/domain/model/providers/AnthropicProvider.ts`
- Modify: `packages/native-runtime/src/agent-runtime/claude-runtime-adapter.ts`
- Unit tests: `packages/core/src/domain/model/providers/__tests__/AnthropicProvider.test.ts`
- Unit tests: `packages/native-runtime/src/agent-runtime/claude-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: Anthropic `thinking_delta` and Claude SDK thinking blocks
- Produces: model `reasoning_delta` for CA Agent and `reasoning_summary_delta` for native Claude

- [x] **Step 1: Map Anthropic thinking and truncation events**

Buffer `thinking_delta.thinking` using the same 256-character/150-millisecond policy, ignore signature deltas, and make Anthropic output-limit stop reasons terminal errors.

- [x] **Step 2: Map native Claude live reasoning**

Convert main-turn Claude SDK `thinking_delta` events into the shared reasoning summary contract while keeping answer text separate.

- [x] **Step 3: Restore Claude reasoning from history**

Project completed assistant thinking blocks into `Message.presentation.reasoning` so refresh preserves the collapsible content.

- [x] **Step 4: Add Anthropic and Claude adapter tests**

Assert live reasoning ordering, truncation failure, signature omission, fallback assistant blocks, and history restoration.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/core/src/domain/model/providers/__tests__/OpenAIProvider.test.ts packages/core/src/domain/agent/__tests__/AgentLoop.test.ts packages/server/app/api/agent-host.test.ts
bun run --cwd packages/core build
bunx tsc --noEmit
```

Expected: all focused tests pass, core builds successfully, and repository TypeScript validation reports no errors introduced by this change.
