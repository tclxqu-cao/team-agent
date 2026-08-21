# Project Context Instruction Whitelist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load fixed project and `.customer-agent/` instruction whitelists, including `AGENTS.md`, without admitting arbitrary Markdown files.

**Architecture:** Extend `ContextLoader` with two ordered path lists and one deterministic recursive instruction-file discovery pass. Preserve the existing `ProjectFile[]` interface and missing-file tolerance; isolate the behavior with temporary-directory tests.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, Bun.

## Global Constraints

- The configured working directory remains the only discovery root; exact fixed-whitelist paths may follow symbolic links as explicit project authorization.
- Root and `.customer-agent/` files use fixed six-path whitelists.
- Recursive discovery recognizes only regular files named `AGENTS.md` and `CLAUDE.md` and ignores symbolic links.
- Do not load parent/home rules or arbitrary Markdown files.
- Do not change context budgets or prompt assembly.

---

### Task 1: Implement and test deterministic fixed-whitelist discovery

**Files:**
- Create: `packages/core/src/domain/context/__tests__/ContextLoader.test.ts`
- Modify: `packages/core/src/domain/context/ContextLoader.ts`
- Test: `packages/core/src/domain/context/__tests__/ContextLoader.test.ts`

**Interfaces:**
- Consumes: `new ContextLoader().loadProjectContext(rootDir): Promise<ProjectFile[]>`
- Produces: ordered, de-duplicated `ProjectFile[]` and its executable discovery contract.

- [ ] **Step 1: Write failing whitelist and ordering tests**

Create a temporary root with all root files, all `.customer-agent/` files, nested `AGENTS.md`/`CLAUDE.md`, arbitrary Markdown, excluded-directory instructions, an exact-whitelist symlink, and a recursively discovered instruction symlink. Assert exact relative path order and contents; assert the whitelist symlink is loaded under its link path while the recursive symlink is ignored; clean the directory in `afterEach`.

```ts
expect(files.map((file) => relative(rootDir, file.path))).toEqual([
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".customer-agent/AGENTS.md",
  ".customer-agent/CLAUDE.md",
  ".customer-agent/README.md",
  ".customer-agent/CONTRIBUTING.md",
  ".customer-agent/.cursorrules",
  ".customer-agent/.github/copilot-instructions.md",
  "apps/api/AGENTS.md",
  "packages/ui/CLAUDE.md",
]);
```

- [ ] **Step 2: Write a failing missing-file tolerance test**

Create only `.customer-agent/AGENTS.md`, load context, and assert one result with no rejection.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bunx vitest run packages/core/src/domain/context/__tests__/ContextLoader.test.ts`

Expected: FAIL because `AGENTS.md` and `.customer-agent/` are not discovered.

- [ ] **Step 4: Define ordered path lists**

Add `ROOT_PROJECT_FILES` and derive `CUSTOMER_AGENT_FILES` with `.customer-agent/` prefixes. Put `AGENTS.md` before `CLAUDE.md` in each list.

- [ ] **Step 5: Generalize recursive instruction discovery**

Replace `findClaudeMdFiles` internals with instruction discovery that accepts both filenames only for regular files, ignores symbolic links, skips `node_modules`, `.git`, and `dist`, sorts directory entries and final paths, and remains tolerant of inaccessible directories. Fixed whitelist loading continues to follow symbolic links.

- [ ] **Step 6: De-duplicate ordered results**

Track loaded absolute paths in a `Set<string>`. Load both whitelist passes first, then append recursive results not already present.

- [ ] **Step 7: Classify AGENTS.md as instruction context**

Return `type: "claude_md"` for both `AGENTS.md` and `CLAUDE.md`, preserving the public union type.

- [ ] **Step 8: Run focused tests**

Run: `bunx vitest run packages/core/src/domain/context/__tests__/ContextLoader.test.ts`

Expected: PASS.

- [ ] **Step 9: Run context and core regression tests**

Run: `bunx vitest run packages/core/src/domain/context packages/core/src/domain/agent`

Expected: PASS with no `ContextAssembler` regression.

---

### Task 2: Verify build, scope, and commit

**Files:**
- Verify: `packages/core/src/domain/context/ContextLoader.ts`
- Verify: `packages/core/src/domain/context/__tests__/ContextLoader.test.ts`

**Interfaces:**
- Produces: buildable core package and clean context-only diff.

- [ ] **Step 1: Build core**

Run: `bun run --cwd packages/core build`

Expected: exit 0.

- [ ] **Step 2: Check formatting and scope**

Run: `git diff --check -- packages/core/src/domain/context`

Expected: no output. Confirm unrelated `WebSearchTool`, desktop icon, `.next`, and `.agents` changes are not staged.

- [ ] **Step 3: Commit the context implementation**

```bash
git add packages/core/src/domain/context/ContextLoader.ts \
  packages/core/src/domain/context/__tests__/ContextLoader.test.ts
git commit -m "feat(context): load project instruction whitelists"
```
