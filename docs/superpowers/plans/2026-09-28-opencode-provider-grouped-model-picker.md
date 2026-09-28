# OpenCode Provider-Grouped Model Picker Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group OpenCode models by provider without repeating the provider on every model option.

**Architecture:** Preserve provider display metadata in the native runtime contract, then use a pure renderer helper to produce ordered `<optgroup>` data. Keep `{ providerID, id }` as the selection and request identity.

**Tech Stack:** TypeScript, React 18, Electron renderer, Vitest.

## Global Constraints

- Only OpenCode gets provider grouping; Codex and Claude Code retain flat lists.
- OpenCode Go is labeled `需订阅` even when a model reports zero input/output cost.
- Existing persisted keys and run payloads remain `providerID/modelID` compatible.
- Do not modify settings-profile grouping.

---

### Task 1: Preserve Provider Display Metadata

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/types.ts`
- Modify: `packages/native-runtime/src/agent-runtime/opencode-runtime-adapter.ts`
- Modify: `packages/native-runtime/src/agent-runtime/opencode-runtime-adapter.test.ts`
- Modify: `packages/desktop/renderer/global.d.ts`

**Interfaces:**
- Produces: `RuntimeModelInfo.providerDisplayName?: string`

- [x] **Step 1: Extend the shared model type**

```ts
export interface RuntimeModelInfo {
  id: string;
  providerID?: string;
  providerDisplayName?: string;
}
```

- [x] **Step 2: Populate provider names in the OpenCode adapter**

Read `provider.name` from `config.providers` and copy it onto each flattened model when non-empty.

- [x] **Step 3: Update the adapter expectation**

Assert that `OpenAI` and `Anthropic` are preserved without changing model IDs or provider IDs.

### Task 2: Build OpenCode Provider Groups

**Files:**
- Modify: `packages/desktop/renderer/lib/native-agent-run-prefs.ts`
- Modify: `packages/desktop/renderer/lib/native-agent-run-prefs.test.ts`

**Interfaces:**
- Consumes: `RuntimeModelInfo[]`
- Produces: `groupOpenCodeModels(models): OpenCodeModelGroup[]`

- [x] **Step 1: Add the pure grouping helper**

The helper preserves first-seen provider order, emits `OpenCode Go（需订阅）`, and leaves each option label as the plain model display name.

- [x] **Step 2: Cover provider and fallback cases**

Test duplicate LongCat names under Zen and Go, model-only option labels, a third-party provider, and missing provider metadata.

### Task 3: Render Grouped OpenCode Options

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: `groupOpenCodeModels(nativeModels)`
- Preserves: `nativeModelKey()` option values and `nativeModelFromKey()` selection decoding

- [x] **Step 1: Memoize OpenCode groups**

Create groups only when `composerAgentType === "opencode"`.

- [x] **Step 2: Render native optgroups**

Render grouped OpenCode options with model-only labels; retain the existing flat rendering for Codex and Claude Code and the existing `设置里的模型` group.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/native-runtime/src/agent-runtime/opencode-runtime-adapter.test.ts packages/desktop/renderer/lib/native-agent-run-prefs.test.ts`

Run: `bunx tsc -p packages/desktop/tsconfig.json --noEmit`

Expected: PASS. Fix failures and rerun until both commands pass.
