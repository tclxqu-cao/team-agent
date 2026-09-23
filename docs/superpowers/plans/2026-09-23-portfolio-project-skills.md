# Portfolio Project Skills Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repository `.agent/skills/portfolio-*` files the only authored source for personal homepage Skills.

**Architecture:** A focused Portfolio Skill catalog resolves and loads the project directory through `SkillLoader`. The Portfolio Agent derives its allowlist from discovered files, while shared run configuration attaches the directory because Portfolio sessions use a separate public-Wiki working directory.

**Tech Stack:** TypeScript, Next.js server routes, AgentBuilder, SkillLoader, Vitest

## Global Constraints

- Preserve all unrelated dirty-worktree changes.
- Do not change normal Agent Skill discovery or SQLite behavior.
- Keep `portfolio-*` capability restrictions and `public_wiki_query` security boundaries.

---

### Task 1: Project Skill Files And Catalog

**Files:**
- Move: `portfolio-skills/*/SKILL.md` -> `.agent/skills/*/SKILL.md`
- Create: `packages/server/lib/portfolio-skill-catalog.ts`
- Delete: `packages/server/lib/portfolio-skill-defaults.ts`
- Unit tests: `packages/server/lib/portfolio-content-agent.test.ts`

**Interfaces:**
- Produces: `portfolioSkillsDirectory(env?)`, `loadPortfolioSkills(directory?)`.

- [x] **Step 1: Move all 16 Skill directories into `.agent/skills`**
- [x] **Step 2: Implement file-backed discovery and full `SKILL.md` loading**
- [x] **Step 3: Add missing-directory and discovery tests**

### Task 2: Agent Binding And Run Activation

**Files:**
- Modify: `packages/server/lib/portfolio-content-agent.ts`
- Modify: `packages/server/app/api/agent/run/route.ts`
- Modify: `packages/server/lib/shared-run-config.ts`
- Unit tests: `packages/server/lib/portfolio-content-agent.test.ts`
- Unit tests: `packages/server/lib/shared-run-config.test.ts`

**Interfaces:**
- Consumes: `loadPortfolioSkills()` and `portfolioSkillsDirectory()`.
- Produces: dynamically synchronized Agent `enabledSkills` and file-backed explicit Skill activation.

- [x] **Step 1: Derive the Portfolio Agent allowlist from discovered files**
- [x] **Step 2: Validate explicit Portfolio Skills against the file catalog**
- [x] **Step 3: Attach the project Skill directory to Portfolio AgentBuilder runs**
- [x] **Step 4: Prevent legacy SQLite Portfolio records from overriding file-backed Skills**
- [x] **Step 5: Update focused tests**

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/server/lib/portfolio-content-agent.test.ts packages/server/lib/shared-run-config.test.ts packages/server/app/api/agent-host.test.ts`

Expected: PASS

Then run: `bun run --filter @agent/server build`

Expected: PASS
