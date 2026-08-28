# TUI Live Progress and Latency Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show immediate, compact TUI lifecycle progress and remove the avoidable semantic skill-matching model request from TUI turns.

**Architecture:** Add an opt-out semantic matching policy to the core builder while preserving the enabled default for every existing caller. Put terminal status formatting and in-place rendering in an import-safe TUI module, then wire the TUI event loop to a single reusable agent configured for local-only skill matching.

**Tech Stack:** TypeScript, JavaScript ES modules, Bun, Vitest, Node terminal ANSI control sequences.

## Global Constraints

- Never expose raw chain-of-thought; map lifecycle events to fixed Chinese labels.
- Preserve Desktop, Server, SDK, model streaming, tool registration, and tool execution behavior.
- Semantic skill matching stays enabled unless a caller explicitly disables it.
- Preserve the existing TUI tool argument and result summaries.
- Clear terminal timers and transient status on completion, error, and cancellation.
- Preserve existing unrelated worktree changes, including the executable mode change on `packages/tui/agent-tui.mjs`.

---

### Task 1: Configurable Semantic Skill Matching

**Files:**
- Modify: `packages/core/src/domain/skill/SkillRegistry.ts`
- Modify: `packages/core/src/domain/agent/AgentBuilder.ts`
- Unit tests: `packages/core/src/domain/skill/__tests__/SkillRegistry.test.ts`
- Unit tests: `packages/core/src/domain/agent/AgentBuilder.test.ts`

**Interfaces:**
- Produces: `SkillRegistry.setSemanticMatchingEnabled(enabled: boolean): void`.
- Produces: `AgentBuilder.withSemanticSkillMatching(enabled: boolean): this`.
- Preserves: `getSkillPrompts(input: string, enabledSkills?: string[] | null): Promise<string>`.

- [x] **Step 1: Inspect the current registry tests and matching fixtures**

Read: `packages/core/src/domain/skill/__tests__/SkillRegistry.test.ts`, `packages/core/src/domain/agent/AgentBuilder.test.ts`.

Confirm: keyword matching, semantic fallback, prompt loading, and builder chaining conventions.

- [x] **Step 2: Add the semantic matching policy to `SkillRegistry`**

Add a default-enabled field and setter:

```ts
private semanticMatchingEnabled = true;

setSemanticMatchingEnabled(enabled: boolean): void {
  this.semanticMatchingEnabled = enabled;
  this.semanticCache.clear();
}
```

Derive the eligible skill collection from `enabledSkills` before matching. Run keyword and explicit slash matching against eligible skills. Only call `findMatchingSemantic` when the policy is enabled and at least one eligible skill exists; restrict the semantic prompt and response lookup to that eligible collection.

- [x] **Step 3: Expose the policy through `AgentBuilder`**

Add a default-enabled builder field and chainable method:

```ts
private semanticSkillMatching = true;

withSemanticSkillMatching(enabled: boolean): this {
  this.semanticSkillMatching = enabled;
  return this;
}
```

Before skill loading in both `build()` and `buildSync()`, call:

```ts
this.skillRegistry.setSemanticMatchingEnabled(this.semanticSkillMatching);
```

- [x] **Step 4: Add focused core tests**

Use a counting mock provider and registered in-memory skill metadata to assert:

```ts
expect(streamChatCalls).toBe(1); // default semantic fallback
registry.setSemanticMatchingEnabled(false);
expect(await registry.getSkillPrompts("unmatched request")).toBe("");
expect(streamChatCalls).toBe(1); // no additional model call
```

Add a separate allowlist test where `enabledSkills` excludes every registered skill and assert the provider is never called. Add a builder chaining assertion:

```ts
expect(builder.withSemanticSkillMatching(false)).toBe(builder);
```

### Task 2: Import-Safe TUI Progress Renderer

**Files:**
- Create: `packages/tui/progress.mjs`
- Unit tests: `packages/tui/progress.test.ts`

**Interfaces:**
- Produces: `formatElapsed(elapsedMs: number): string`.
- Produces: `thinkingLabel(message: string): string`.
- Produces: `TurnProgress` with `start(label)`, `update(label)`, `clear()`, `complete()`, and `dispose()` methods.

- [x] **Step 1: Implement pure status formatting**

Map only recognized lifecycle messages and return a generic label otherwise:

```js
export function thinkingLabel(message) {
  const iteration = /^Iteration (\d+)\.\.\.$/.exec(message);
  if (iteration) return `思考中 · 第 ${iteration[1]} 轮`;
  if (message.startsWith("Retrying")) return "重试中";
  if (message.includes("compacting")) return "整理上下文";
  return "思考中";
}
```

Format elapsed time as seconds with one decimal below one minute, then `M:SS` at one minute or more.

- [x] **Step 2: Implement the in-place terminal renderer**

`TurnProgress` accepts injected `write`, `now`, interval scheduling, and text styling so tests do not touch the real terminal. It writes `\r\x1b[2K` before a status refresh, refreshes elapsed time every 100 ms, and makes `clear()` and `dispose()` idempotent. `complete()` clears the live line, stops the timer, and writes one dim completion line containing total elapsed time.

- [x] **Step 3: Add deterministic renderer tests**

Use fake time and captured writes to assert:

```js
expect(thinkingLabel("Iteration 2...")).toBe("思考中 · 第 2 轮");
expect(thinkingLabel("untrusted internal details")).toBe("思考中");
expect(formatElapsed(6503)).toBe("6.5s");
```

Verify repeated cleanup does not append output, refresh replaces one line instead of adding lines, and `complete()` writes exactly one total-duration line.

### Task 3: Wire Progress Into the TUI Event Loop

**Files:**
- Modify: `packages/tui/agent-tui.mjs`

**Interfaces:**
- Consumes: `AgentBuilder.withSemanticSkillMatching(false)` from Task 1.
- Consumes: `TurnProgress` and `thinkingLabel` from Task 2.
- Preserves: existing TUI commands, session location, tool summaries, and `askInline` behavior.

- [x] **Step 1: Build and retain one agent instance**

Move agent construction into an `initializeAgent()` function called once from `main()`:

```js
agent = await new Core.AgentBuilder()
  .withWorkingDirectory(workDir)
  .withSessionStore(sessionStore)
  .withModel(provider, { apiKey, modelId, baseUrl })
  .withSemanticSkillMatching(false)
  .withTool(new Core.AskUserTool(async (request) => await askInline(request)))
  .build();
```

Do not set `agent` back to `null` after a turn.

- [x] **Step 2: Render event-driven lifecycle state**

At turn submission create a `TurnProgress`, immediately call `start("准备上下文")`, and pass it into `renderEvent`. Handle `thinking` with `thinkingLabel`, keep tool call/result summaries, show `执行工具 · <name>` after printing a tool call, and clear progress before streamed text or errors. Track whether text streamed so `text_done` only prints a newline for actual text.

- [x] **Step 3: Make completion and cancellation cleanup single-shot**

On `done`, call `progress.complete()`. In `finally`, call `progress.dispose()` and clear the active progress reference. On `Ctrl+C`, call `agent.abort()` and clear the live line; let the pending line handler restore the prompt after `runTurn` exits instead of printing a second prompt from the signal handler.

### Task 4: Runtime and Regression Verification

**Files:**
- Modify only if failures expose an implementation defect in files already listed above.

**Interfaces:**
- Consumes: completed core and TUI behavior from Tasks 1-3.

- [x] **Step 1: Build the core package**

Run:

```bash
bun run --cwd packages/core build
```

Expected: exit code 0 and updated `packages/core/dist` exposes `withSemanticSkillMatching` to the TUI package import.

- [x] **Step 2: Run a timed real-provider TUI interaction**

Start:

```bash
bun --env-file=packages/server/.env.local run tui
```

Submit `请务必使用 bash 工具执行 pwd，并告诉我输出。` and confirm the first visible status appears immediately, the `bash` call and result remain visible, completion time prints once, and the prompt returns without stale status output.

- [x] **Step 3: Compare preflight timing**

Run an event timing harness with the same configured provider and confirm `thinking` appears without the prior semantic matching model round trip. Record the measured first-event and total duration; treat provider variation as expected, but fail verification if the semantic provider call still occurs when disabled.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/core/src/domain/skill/__tests__/SkillRegistry.test.ts packages/core/src/domain/agent/AgentBuilder.test.ts packages/tui/progress.test.ts
bun run --cwd packages/core test
bunx tsc --noEmit
```

Expected: all focused tests and the complete core suite pass; TypeScript reports no errors. If a test fails, fix the implementation or test and rerun until it passes. Report each command and result in the final response.

Verification note: focused tests and the complete core suite pass. Root TypeScript checking reaches an unrelated pre-existing conflict in `packages/sdk/src/components/AgentChat.ts` where an imported and local `renderMarkdown` declaration share the same name; the core package build and declarations pass.
