# Customer Agent TUI Visual Hierarchy and Keyboard Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Ink TUI a clear operator-console hierarchy and reliable palette navigation across common terminal cursor-key encodings.

**Architecture:** Centralize semantic presentation tokens, extract the header, and let each existing Ink component own one visual region. Normalize navigation input inside the composer so application cursor mode and normal cursor mode share the same callbacks.

**Tech Stack:** TypeScript, React 18, Ink 5, Vitest, ink-testing-library, Bun

## Global Constraints

- Preserve all existing commands, skills, project/file mentions, model persistence, live events, sessions, and inline questions.
- Do not add runtime dependencies.
- Render cleanly at 60 terminal columns and above.
- Use cyan for Agent/selection, green for user/ready, yellow for progress/questions, magenta for tools, and red only for failures.
- Keep palette and composer as one interaction surface without nested decorative panels.

---

### Task 1: Semantic Theme and Header

**Files:**
- Create: `packages/tui/src/theme.ts`
- Create: `packages/tui/src/components/Header.tsx`
- Modify: `packages/tui/src/App.tsx`
- Unit tests: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Consumes: `RuntimeSnapshot`, `running: boolean`
- Produces: `TUI_THEME`, `Header({ snapshot, running })`

- [ ] **Step 1: Define terminal presentation tokens**

Create a typed token object for semantic colors and terminal-safe role/status labels.

- [ ] **Step 2: Implement the compact header**

Render brand, ready/running status, model, project basename, and session prefix in a single bordered region with truncation.

- [ ] **Step 3: Compose the header and empty state**

Replace the plain two-line header and add a concise startup invitation when the transcript is empty.

### Task 2: Transcript and Progress Hierarchy

**Files:**
- Modify: `packages/tui/src/components/Transcript.tsx`
- Modify: `packages/tui/src/components/ProgressLine.tsx`
- Modify: `packages/tui/src/components/InlineQuestion.tsx`
- Unit tests: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Consumes: existing `TranscriptEntry`, `ProgressState`, and `AskUserRequest`
- Produces: stable role rails and semantic status/question bands

- [ ] **Step 1: Render stable transcript roles**

Give user, Agent, tool, result, notice, and error entries consistent labels, indentation, colors, and wrapping.

- [ ] **Step 2: Render progress as a status band**

Keep the 100 ms elapsed-time update while separating running, completed, and token data visually.

- [ ] **Step 3: Align inline questions with the interaction language**

Use the same amber state and numbered option hierarchy as the rest of the TUI.

### Task 3: Interaction Surface and Keyboard Normalization

**Files:**
- Modify: `packages/tui/src/components/CommandPalette.tsx`
- Modify: `packages/tui/src/components/Composer.tsx`
- Modify: `packages/tui/src/App.tsx`
- Unit tests: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Consumes: `paletteOpen`, `onPaletteMove(-1 | 1)`, `onPaletteSelect`, `onPaletteClose`
- Produces: `navigationDirection(input, key): -1 | 1 | null` and a unified framed keyboard surface

- [ ] **Step 1: Normalize cursor-key encodings**

Recognize Ink flags plus CSI `\u001b[A/B` and SS3 `\u001bOA/OB`, routing them to palette movement before history.

- [ ] **Step 2: Strengthen selected-row feedback**

Show selected position, a persistent `›` marker, selected background color, disabled copy, scroll position, and keyboard hints.

- [ ] **Step 3: Frame the composer**

Give the prompt a stable label, ready/running/question color, input cursor, and bottom help line without changing edit behavior.

- [ ] **Step 4: Add keyboard regression tests**

Open `/`, send CSI Down and SS3 Down/Up, assert the selected marker moves, press Enter, and assert the selected command is inserted or executed rather than input history changing.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/tui/src/*.test.ts packages/tui/src/*.test.tsx packages/core/src/domain/agent/AgentBuilder.test.ts packages/core/src/domain/skill/__tests__/SkillRegistry.test.ts && bunx tsc --noEmit -p packages/tui/tsconfig.json`

Expected: all focused tests pass and TypeScript exits 0.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
