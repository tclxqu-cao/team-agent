# Agent Structured JSON Rendering Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render complete Agent JSON replies as semantic message content or a generic JSON tree in the shared Desktop/Web chat, with Chinese suggestion buttons that send through the existing chat pipeline without disturbing the composer draft.

**Architecture:** Add a pure anti-corruption parser that turns untrusted assistant text into a small presentation model, then render that model in a focused React component. Keep Markdown rendering unchanged and let `ChatView` compose structured output with a shared submission descriptor so composer sends and suggestion sends use the same session, queue, and run paths.

**Tech Stack:** TypeScript, React 18, Vitest, React DOM server rendering, Lucide React, existing semantic CSS variables, Node 22.

## Global Constraints

- Structured rendering applies only to complete top-level assistant messages whose entire trimmed content is a JSON object or array.
- Ordinary text, mixed text/JSON, JSON code fences, scalar JSON, incomplete streams, invalid JSON, and oversized input keep the existing Markdown renderer.
- Desktop and WebApp must consume the same renderer implementation under `packages/desktop/renderer`.
- Never render model-provided HTML with `dangerouslySetInnerHTML`; unknown blocks remain inspectable as data.
- Suggestion sends must preserve the current draft and exclude pending images, attached files, selected agents, and goal-mode interpretation.
- All new visual states use existing semantic theme variables; no skin-specific colors or per-skin overrides.
- Do not modify or stage unrelated working-tree changes.

---

### Task 1: Structured Message Presentation Model

**Files:**
- Create: `packages/desktop/renderer/lib/structured-agent-message.ts`
- Create: `packages/desktop/renderer/lib/structured-agent-message.test.ts`

**Interfaces:**
- Consumes: raw assistant message text and a completion flag.
- Produces: `parseStructuredAgentMessage(text: string, complete?: boolean): StructuredAgentMessage | null`, `suggestionLabel(command: string): string`, and exported JSON/envelope presentation types.

- [x] **Step 1: Define the JSON and presentation model types**

Add recursive JSON types plus a discriminated result:

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type AgentMessageBlock =
  | { kind: "text"; text: string; tone?: string }
  | { kind: "unknown"; blockType: string; value: JsonValue };

export type StructuredAgentMessage =
  | { kind: "envelope"; raw: string; value: AgentMessageEnvelope }
  | { kind: "json"; raw: string; value: JsonObject | JsonValue[] };
```

`AgentMessageEnvelope` carries validated `schemaVersion`, `title`, optional `skill`, `summary`, `generatedAt`, normalized blocks, string suggestions, string sources, and the original parsed object for raw inspection.

- [x] **Step 2: Implement strict whole-message parsing and bounded normalization**

Use these rules in `parseStructuredAgentMessage`:

```ts
export const MAX_STRUCTURED_MESSAGE_CHARS = 200_000;

export function parseStructuredAgentMessage(text: string, complete = true): StructuredAgentMessage | null {
  const raw = text.trim();
  if (!complete || raw.length === 0 || raw.length > MAX_STRUCTURED_MESSAGE_CHARS || raw.startsWith("```")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  // Normalize schemaVersion/title/blocks envelopes; otherwise return object/array JSON.
}
```

Recognize an envelope only when `schemaVersion` is a number, `title` is a non-empty string, and `blocks` is an array. Convert valid `{ type: "text", text: string }` items to text blocks; preserve every other block as `unknown`. Keep at most 24 suggestions and 30 sources, trim each string, and cap individual labels to their server-side limits.

- [x] **Step 3: Implement transparent suggestion labels**

Map the known commands exactly:

```ts
const labels: Record<string, string> = {
  "/help": "使用帮助",
  "/whoami": "关于我",
  "/works": "项目与作品",
  "/jobs": "求职信息",
  "/timeline": "经历时间线",
  "/contact": "联系方式",
};
```

Render `/project abc` as `查看项目：abc`; return every unknown suggestion unchanged so the visible action never conceals what will be sent.

- [x] **Step 4: Add parser and label tests**

Test the screenshot-shaped envelope, unknown blocks, a generic nested object, a root array, whitespace, invalid JSON, mixed prose, fenced JSON, scalar JSON, incomplete messages, over-limit input, list limits, and every suggestion label. Assert malformed optional fields are ignored without losing valid text blocks.

### Task 2: Structured Message React View

**Files:**
- Create: `packages/desktop/renderer/components/StructuredAgentMessage.tsx`
- Create: `packages/desktop/renderer/components/StructuredAgentMessage.test.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `text`, `complete`, `renderText`, `suggestionsEnabled`, `onSuggestionSend`, and optional `onCopyFailed`.
- Produces: `StructuredAgentMessageView` for a parsed model and default `StructuredAgentMessage` for parse-or-fallback behavior.

- [x] **Step 1: Build the parse-or-fallback component boundary**

Create these props and keep fallback rendering explicit:

```tsx
interface StructuredAgentMessageProps {
  text: string;
  complete: boolean;
  renderText: (text: string) => React.ReactNode;
  suggestionsEnabled: boolean;
  onSuggestionSend: (command: string) => void;
  onCopyFailed?: () => void;
}

const parsed = useMemo(() => parseStructuredAgentMessage(text, complete), [complete, text]);
return parsed
  ? <StructuredAgentMessageView message={parsed} {...actionProps} />
  : <>{renderText(text)}</>;
```

Do not call the parser from `renderAssistantText`; reasoning summaries and Chrome Hub must keep the current Markdown-only path.

- [x] **Step 2: Render known envelopes as semantic message sections**

Render a compact heading, optional summary, text blocks via `renderText`, unknown blocks via `JsonValueTree`, suggestion buttons, collapsed sources, collapsed message metadata, and collapsed formatted raw JSON. Use `copyTextToClipboard(message.raw)` from the existing clipboard adapter and report failure through `onCopyFailed`.

Suggestion buttons call `onSuggestionSend(command)` exactly once, show `suggestionLabel(command)`, and include the original command in `title` and `aria-label`. Disable them when `suggestionsEnabled` is false.

- [x] **Step 3: Render generic JSON as a bounded recursive tree**

Implement `JsonValueTree` with semantic primitive classes, object keys, array indices and native `<details>` disclosure. Open the root level by default, stop automatic recursive expansion at depth 2, cap active recursive rendering at depth 8, and show 40 children initially per container. A local “显示其余 N 项” button reveals the remaining children; the raw JSON disclosure always preserves the complete source.

- [x] **Step 4: Add theme-native responsive styles**

Add `.structured-agent-message`, `.structured-agent-message__title`, `.structured-agent-message__suggestions`, `.structured-agent-suggestion`, `.json-tree`, `.json-tree__row`, primitive value classes, disclosure, metadata, raw JSON, copy, hover, disabled, focus-visible, and narrow viewport rules to `global.css`.

Use `var(--bg-surface)`, `var(--bg-deep)`, `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)`, `var(--accent)`, `var(--accent-dim)`, `var(--border-subtle)`, `var(--focus-ring)`, and radii no larger than 8px. Do not add fixed palette colors or a nested outer card.

- [x] **Step 5: Add rendering and safety tests**

Use `renderToStaticMarkup` to assert the title, text, Chinese suggestion label, original-command accessibility text, disabled state, source count, message metadata, raw disclosure, generic keys, arrays, empty values, and theme classes. Pass `<script>alert(1)</script>` in a text/unknown block and assert it is escaped and no executable tag or `dangerouslySetInnerHTML` path exists.

### Task 3: Shared Chat Submission Descriptor

**Files:**
- Create: `packages/desktop/renderer/lib/chat-submission.ts`
- Create: `packages/desktop/renderer/lib/chat-submission.test.ts`
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.ts`
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.test.ts`

**Interfaces:**
- Consumes: current composer text/context or a suggestion command.
- Produces: `createComposerSubmission(input): ChatSubmission`, `createSuggestionSubmission(command): ChatSubmission`, and an optional `restoreDraftOnFailure` flag carried by `OccupiedSendPayload`.

- [x] **Step 1: Define one submission value object for both entry points**

```ts
export interface ChatSubmission {
  text: string;
  origin: "composer" | "suggestion";
  applyGoalMode: boolean;
  clearComposer: boolean;
  restoreDraftOnFailure: boolean;
  agentIds?: string[];
  agentName?: string;
  images?: string[];
}
```

`createComposerSubmission` trims the text, copies arrays, carries current agents/images, and sets all three behavior flags to `true`. `createSuggestionSubmission` trims only the command, includes no composer context, sets `applyGoalMode` and `clearComposer` to `false`, and sets `restoreDraftOnFailure` to `false`.

- [x] **Step 2: Preserve failure semantics through occupied-session recovery**

Add `restoreDraftOnFailure?: boolean` to `OccupiedSendPayload` and copy it in `createOccupiedSessionRecovery`. Existing payloads without the flag retain current behavior; only an explicit `false` prevents a failed suggestion from replacing the user's composer draft.

- [x] **Step 3: Test descriptor isolation and payload copying**

Assert composer submissions retain cloned agent/image arrays and suggestion submissions contain only trimmed command text. Extend occupied recovery tests to prove `restoreDraftOnFailure: false` survives recovery and fork transitions.

### Task 4: ChatView Integration and Direct Suggestion Send

**Files:**
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `StructuredAgentMessage`, `createComposerSubmission`, `createSuggestionSubmission`, and the extended `OccupiedSendPayload`.
- Produces: top-level assistant structured rendering plus one shared `submitChatMessage(submission: ChatSubmission): Promise<void>` path.

- [x] **Step 1: Replace implicit composer reads with an explicit submission**

Rename the body of `handleSend` to `submitChatMessage(submission)` and replace direct reads with:

```ts
const finalMsg = submission.text;
const goalObjective = explicitGoal
  ? explicitGoal[1]?.trim() ?? ""
  : submission.applyGoalMode && goalMode ? finalMsg : null;
const agentNamesLabel = submission.agentName;
const imagesToSend = submission.images;
const agentIdsToSend = submission.agentIds ?? [];
```

Guard on `submission.text`, `canCompose`, and image reads. Clear `pendingAgents`, the input, attachments, image drafts, and session drafts only when `submission.clearComposer` is true. Restore the failed queue/native payload into the composer only when `submission.restoreDraftOnFailure` is not false.

- [x] **Step 2: Keep the composer entry point behavior unchanged**

Implement `handleSend()` as:

```ts
const handleSend = async () => submitChatMessage(createComposerSubmission({
  text: input,
  agentIds: pendingAgents.map((agent) => agent.id),
  agentName: pendingAgents.length ? pendingAgents.map((agent) => agent.name).join(", ") : undefined,
  images: pendingImages,
}));
```

Use the same conditional clear helper in `/loop` branches so ordinary composer commands still clear after admission while future suggestion commands cannot erase an unrelated draft.

- [x] **Step 3: Add the suggestion entry point**

Add `handleSuggestionSend(command)` that builds `createSuggestionSubmission(command)` and calls `submitChatMessage`. It must use the current session/project/runtime, current queue policy, existing `prepareChatCommand`, `onMessageSent`, and `startRun` exactly like composer text.

When recording a native pending send, store `restoreDraftOnFailure`. In `startRun` failure handling, always remove the pending payload but only write/set composer drafts when the flag is not `false`.

- [x] **Step 4: Render only completed assistant bodies structurally**

Replace the top-level assistant body call with:

```tsx
<StructuredAgentMessage
  text={msg.content}
  complete={!(isRunning && isLastAssistant)}
  renderText={renderMessageContent}
  suggestionsEnabled={canCompose && pendingImageReads === 0}
  onSuggestionSend={handleSuggestionSend}
  onCopyFailed={() => setError("复制失败，请选择文字后复制")}
/>
```

Leave user messages, reasoning summaries, tool-call content, Markdown code fences, and `ChromeHubPane` on `renderAssistantText`.

- [x] **Step 5: Add source-contract integration assertions**

Extend `ChatHistoryStyle.test.ts` to assert `StructuredAgentMessage` is wired only in the assistant message branch, receives the completion/suggestion props, and existing `renderMessageContent` remains passed to `ReasoningSummary`. Assert the new CSS uses semantic variables and contains focus-visible and disabled styles.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/desktop/renderer/lib/structured-agent-message.test.ts \
  packages/desktop/renderer/components/StructuredAgentMessage.test.tsx \
  packages/desktop/renderer/lib/chat-submission.test.ts \
  packages/desktop/renderer/lib/occupied-session-fork.test.ts \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts \
  packages/desktop/renderer/components/MermaidBlock.test.tsx
bunx tsc --noEmit
bun run --cwd packages/desktop build
bun run --cwd packages/webapp build
```

Expected: all focused tests pass; TypeScript reports no errors; Desktop and WebApp builds succeed.

If a test fails, fix the implementation or test and rerun the failing command until it passes. Report every command and result in the final response.
