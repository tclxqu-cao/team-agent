# AIHub Tool Call Command Recovery Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve DeepSeek tool-call protocol text exactly enough for AIHub to execute commands containing raw URLs and single-quoted JSON bodies, while retaining compact Markdown formatting for ordinary assistant replies.

**Architecture:** The desktop extractor will detect a `tool_call` envelope from raw cloned text before converting normal response HTML to Markdown, so anchors cannot rewrite command URLs. The core parser will keep its existing malformed-JSON repair path, validate quotes followed by `}` or `]` against the remaining container structure, and branch only after an unescaped inner quote when a comma could be either shell JSON content or the outer argument boundary.

**Tech Stack:** TypeScript, Electron `WebContentsView` extraction scripts, Vitest, Bun

## Global Constraints

- Preserve all existing direct JSON, fenced JSON, DSML, malformed quote, illegal shell escape, shell backreference, multiline command, and registered-tool validation behavior.
- Preserve compact Markdown structure for normal assistant replies, including paragraph/list/code/table line breaks without widening vertical spacing.
- Use the captured DeepSeek response for order `OHR3D5ARJ1062P006513` only as a parser fixture; never call the finance endpoint.
- Keep the change scoped to AIHub extraction and parsing; do not alter unrelated existing worktree changes.
- Implement directly in the current session without subagents, commits, or pushes.

---

### Task 1: Lock The Production Failure Into Focused Regressions

**Files:**
- Modify: `packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts`
- Modify: `packages/desktop/main/ai-hub/adapters.test.ts`

**Interfaces:**
- Consumes: `parseAiHubToolCall(reply: string, tools: ToolDefinition[]): ToolCall | null`, `CONVERSATION_EXTRACT_SCRIPT: string`
- Produces: regression coverage for raw protocol extraction and malformed command JSON recovery

- [x] **Step 1: Add the exact parser regression fixture**

Add a `bash` tool test using the production-shaped response and assert that the recovered command retains both the plain URL and the nested JSON body:

```ts
const reply = String.raw`{"type":"tool_call","id":"call_curl_query1","name":"bash","arguments":{"command":"curl -s -X POST 'http://finance.fly.17usoft.com/clear/api/PaymentOrder/QueryListBySerialId' -H 'Content-Type: application/json' -d '{"Serialid":"OHR3D5ARJ1062P006513"}'","timeout":30000}}`;

expect(parseAiHubToolCall(reply, bashTools)).toEqual({
  id: "call_curl_query1",
  name: "bash",
  arguments: {
    command: "curl -s -X POST 'http://finance.fly.17usoft.com/clear/api/PaymentOrder/QueryListBySerialId' -H 'Content-Type: application/json' -d '{\"Serialid\":\"OHR3D5ARJ1062P006513\"}'",
    timeout: 30000,
  },
});
```

- [x] **Step 2: Add the extractor source-contract regression**

Assert that `CONVERSATION_EXTRACT_SCRIPT` obtains raw protocol text from the cloned DeepSeek node, recognizes the `tool_call` marker before Markdown serialization, and still retains the existing Markdown path:

```ts
expect(CONVERSATION_EXTRACT_SCRIPT).toContain("const protocolText = clean(clone.textContent)");
expect(CONVERSATION_EXTRACT_SCRIPT).toContain('protocolText.includes(\'"tool_call"\')');
expect(CONVERSATION_EXTRACT_SCRIPT.indexOf("const protocolText = clean(clone.textContent)"))
  .toBeLessThan(CONVERSATION_EXTRACT_SCRIPT.indexOf("return clean(markdown(clone))"));
expect(CONVERSATION_EXTRACT_SCRIPT).toContain("return clean(markdown(clone))");
```

### Task 2: Preserve Tool Protocol Text Before Markdown Serialization

**Files:**
- Modify: `packages/desktop/main/ai-hub/adapters.ts:293`
- Unit tests: `packages/desktop/main/ai-hub/adapters.test.ts`

**Interfaces:**
- Consumes: a cloned DeepSeek `.ds-markdown` element after math annotations are normalized
- Produces: `deepSeekText(el): string`, returning raw text for protocol envelopes and compact Markdown for ordinary replies

- [x] **Step 1: Detect protocol text on the cloned DOM before walking Markdown nodes**

Inside `deepSeekText`, compute the raw clone text and return it only when it starts with an object and declares a `tool_call` envelope:

```ts
const protocolText = clean(clone.textContent);
if (protocolText.startsWith("{")
  && protocolText.includes('"type"')
  && protocolText.includes('"tool_call"')) return protocolText;
```

- [x] **Step 2: Keep normal response serialization unchanged**

Leave the existing `markdown(node)` walker and `return clean(markdown(clone))` path in place so paragraphs, lists, code blocks, tables, links, and compact blank-line normalization remain available for non-protocol responses.

### Task 3: Reject False String Boundaries Before Inner Shell Text

**Files:**
- Modify: `packages/core/src/domain/model/providers/AiHubProvider.ts:520`
- Unit tests: `packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts`

**Interfaces:**
- Consumes: malformed JSON passed through `repairMalformedToolCallJson(text: string): string`
- Produces: repaired JSON in which nested shell JSON quotes are escaped without changing valid outer string boundaries

- [x] **Step 1: Add a narrow container-continuation predicate**

Add a helper that starts at a candidate `}` or `]`, consumes legal closing delimiters, and accepts only end-of-input or a comma followed by a plausible next JSON value/key token:

```ts
function hasValidJsonContainerContinuation(text: string, start: number): boolean {
  let cursor = start;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    const char = text[cursor];
    if (char === '}' || char === ']') {
      cursor += 1;
      continue;
    }
    if (char !== ',') return false;
    cursor += 1;
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    return /["{\[\-0-9tfn]/.test(text[cursor] ?? '');
  }
  return true;
}
```

- [x] **Step 2: Apply the predicate only to closing-container candidates**

Keep key strings closing on `:` and value strings closing on `,`. For `}` or `]`, additionally require `hasValidJsonContainerContinuation(text, index + 1)`; otherwise escape the quote as command content.

```ts
const closesContainer = next === '}' || next === ']';
const closesString = stringIsKey
  ? next === ':'
  : next === ',' || (closesContainer && hasValidJsonContainerContinuation(text, index + 1));
```

- [x] **Step 3: Disambiguate commas inside multi-field shell JSON**

After an unescaped quote has already been repaired inside a value string, retain bounded alternatives for a quote followed by a comma: one treats it as nested shell content and one as the outer JSON string boundary. Select the first candidate that passes `JSON.parse`, while normal valid value strings continue to close directly without branching. Cover nested objects and arrays in the regression fixture.

### Task 4: Runtime And Regression Verification

**Files:**
- Verify: `packages/core/src/domain/model/providers/AiHubProvider.ts`
- Verify: `packages/desktop/main/ai-hub/adapters.ts`

**Interfaces:**
- Consumes: built core and desktop source plus the local AIHub relay/runtime
- Produces: evidence that existing parsing remains green and a harmless live command reaches tool execution

- [x] **Step 1: Run focused parser and extractor tests**

Run:

```bash
bunx vitest run packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts packages/desktop/main/ai-hub/adapters.test.ts
```

Expected: both files pass, including the new captured-response fixture and all prior parsing cases.

- [x] **Step 2: Run the complete AIHub regression set**

Run:

```bash
bunx vitest run packages/core/src/domain/ai-hub packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts packages/desktop/main/ai-hub packages/desktop/renderer/lib/ai-hub-layout.test.ts packages/server/lib/ai-hub-relay-client.test.ts packages/server/app/web/AiHubPane.test.tsx
```

Expected: all 21 discovered AIHub test files and 221 tests pass.

- [x] **Step 3: Build both affected packages and check the diff**

Run:

```bash
bun run --cwd packages/core build
bun run --cwd packages/desktop compile
git diff --check
```

Expected: core build, desktop TypeScript compile, and whitespace validation all exit successfully.

- [x] **Step 4: Restart the desktop development runtime**

Confirm whether the current `5173` development topology is alive, then restart it through the repository's existing development command so Electron reloads the updated main-process extraction script. Verify the listener, Electron process, and AIHub relay status after restart.

- [x] **Step 5: Perform a harmless live tool-loop check**

Use a fresh AIHub session and ask the model to invoke `bash` with a command that contains a raw `http://example.invalid/...` string and a single-quoted JSON literal but performs no network request, such as `printf '%s\n' 'http://example.invalid/path' '{"sample":"value"}'`. Verify that the captured response becomes a standard `tool_call`, the command executes, and the final response uses the successful result.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/core/src/domain/model/providers/__tests__/AiHubProvider.test.ts packages/desktop/main/ai-hub/adapters.test.ts
```

Expected: PASS. If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
