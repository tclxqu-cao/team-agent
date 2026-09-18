# AI Hub Tool JSON Recovery Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably recover and execute valid registered tool calls when DeepSeek renders shell syntax as math or emits invalid JSON backslash escapes.

**Architecture:** Restore DeepSeek markdown text from KaTeX source annotations before transport. Then apply a narrowly scoped JSON-string escape repair before existing tool whitelist and argument validation.

**Tech Stack:** TypeScript, Electron CDP DOM extraction, Vitest.

## Global Constraints

- Preserve registered-tool and arguments-object validation.
- Do not execute arbitrary prose or incomplete JSON.
- Do not expose command secrets in logs or UI diagnostics.

---

### Task 1: DeepSeek markdown extraction

**Files:**
- Modify: `packages/desktop/main/ai-hub/adapters.ts`
- Unit tests: `packages/desktop/main/ai-hub/adapters.test.ts`

**Interfaces:**
- Consumes: DeepSeek `.ds-markdown` DOM nodes and KaTeX `annotation[encoding="application/x-tex"]` nodes.
- Produces: Conversation text with math-rendered shell expressions restored to `$...$` source text.

- [ ] **Step 1: Restore KaTeX source before reading message text**

Clone each message node, replace rendered KaTeX containers with their source annotation wrapped in dollar delimiters, then read `innerText`/`textContent` from the clone.

- [ ] **Step 2: Add extraction contract assertions**

Verify the generated browser script contains annotation-based restoration and still parses as JavaScript.

### Task 2: Restricted JSON escape repair

**Files:**
- Modify: `packages/core/src/domain/model/providers/AiHubProvider.ts`
- Unit tests: `packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts`

**Interfaces:**
- Consumes: A complete candidate tool-call JSON object.
- Produces: Parsed tool calls after escaping only backslashes that do not begin a legal JSON escape.

- [ ] **Step 1: Repair invalid escapes inside JSON strings**

Preserve `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, and valid `\uXXXX`; duplicate the backslash for other sequences such as `\1`, `\(`, and `\.`.

- [ ] **Step 2: Cover real DeepSeek shell payloads and rejection cases**

Add tests for sed backreferences, shell commands containing `$()`, legal escapes, incomplete JSON, unknown tools, and non-object arguments.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts packages/desktop/main/ai-hub/adapters.test.ts`

Expected: PASS
