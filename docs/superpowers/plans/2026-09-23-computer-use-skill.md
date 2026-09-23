# Customer Agent Computer Use Skill Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded `computer-use` Skill that Customer Agent users can invoke from the desktop composer with `/computer-use <task>`.

**Architecture:** `@agent/computer-use` exports the immutable Skill definition. Customer Agent composition registers it independently from the relay-backed `computer` tool, and AgentLoop loads an exact leading slash Skill without changing the user message or enabling semantic preloading.

**Tech Stack:** TypeScript, Bun workspaces, Vitest, Electron relay, Customer Agent Core/Server.

## Global Constraints

- Keep Codex, Claude Code, and OpenCode runtime adapters unchanged.
- Keep `computer` as a single-action, Accessibility-first tool with screenshot fallback.
- Do not bypass macOS Accessibility or Screen Recording permissions.
- Do not overwrite unrelated changes in the dirty working tree.
- Do not commit or push unless the user explicitly requests it.

---

### Task 1: Built-in Skill Definition

**Files:**
- Create: `packages/computer-use/src/skill/computer-use-skill.ts`
- Create: `packages/computer-use/src/skill/computer-use-skill.test.ts`
- Modify: `packages/computer-use/src/index.ts`

**Interfaces:**
- Consumes: `SkillDefinition` from `@agent/core`.
- Produces: `COMPUTER_USE_SKILL_NAME: "computer-use"` and `COMPUTER_USE_SKILL: SkillDefinition`.

- [x] **Step 1: Add the Skill definition**

Define immutable metadata and a compact prompt covering explicit activation, purpose-built-tool preference, observe-first behavior, one action per call, post-action verification, stale revision recovery, and hard-stop errors.

- [x] **Step 2: Export the Skill**

Re-export the definition from `packages/computer-use/src/index.ts`.

- [x] **Step 3: Add focused definition tests**

Assert stable name, metadata, built-in path, and all workflow invariants required by the design.

### Task 2: Exact Slash Skill Activation

**Files:**
- Modify: `packages/core/src/domain/agent/AgentLoop.ts`
- Modify: `packages/core/src/domain/agent/__tests__/AgentLoop.test.ts`

**Interfaces:**
- Consumes: `ISkillRegistry.load(name, enabledSkills)`.
- Produces: exact leading slash Skill prompt injection for the current run.

- [x] **Step 1: Parse a leading slash Skill name**

Recognize `/name` only at the start of the input and only when followed by whitespace or end-of-input.

- [x] **Step 2: Merge explicit and slash-selected Skills**

Keep trusted `activatedSkills` fail-fast behavior, load the slash-selected Skill opportunistically, deduplicate by name, and leave input unchanged.

- [x] **Step 3: Add focused AgentLoop tests**

Cover successful `/computer-use`, unchanged input, no implicit natural-language preload, unknown Skill, allowlist rejection, and deduplication.

### Task 3: Customer Agent Registration and Catalog

**Files:**
- Modify: `packages/server/lib/computer-use.ts`
- Modify: `packages/server/lib/computer-use.test.ts`
- Modify: `packages/server/app/api/agent-host.ts`
- Modify: `packages/server/app/api/agent-host.test.ts`
- Modify: `packages/server/lib/business-catalog.ts`
- Modify: `packages/desktop/main/agent-host.ts`

**Interfaces:**
- Consumes: `COMPUTER_USE_SKILL` and the existing `registerCustomerComputerTool(builder)` relay probe.
- Produces: `registerCustomerComputerSkill(builder): void` and Skill list entries independent of the working directory.

- [x] **Step 1: Register the built-in Skill in Customer Agent**

Register the Skill after stored/discovered skills are applied and before `AgentLoop.run()` starts. Keep relay-backed tool registration as a separate operation.

- [x] **Step 2: Add the built-in Skill to catalogs**

Merge the built-in metadata into Server and legacy Desktop skill lists with `enabled: true`, replacing same-name external metadata so the built-in contract is authoritative.

- [x] **Step 3: Update composition tests**

Assert Skill registration is unconditional and computer tool registration is still conditional on a compatible relay.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/computer-use/src/skill/computer-use-skill.test.ts packages/core/src/domain/agent/__tests__/AgentLoop.test.ts packages/server/lib/computer-use.test.ts
bunx tsc --noEmit -p packages/computer-use
bun run --cwd packages/computer-use build
```

Expected: all focused tests, type checks, and package build pass. Then run the affected Server/Desktop TypeScript checks or builds required by changed imports and report any unrelated pre-existing failures separately.
