# Codex Visualize Artifact and Live History Reconciliation Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Codex `visualize` markers as safe WebApp artifact links and reconcile selected native-session history whenever its transcript changes.

**Architecture:** Extend the existing rich-inline tokenizer so the Codex private marker produces the same `artifact` token already consumed by `ChatView`. Keep `/api/agent/stream` as the low-latency channel, but allow every selected native session to use the existing transcript revision observer as an eventual-consistency path.

**Tech Stack:** TypeScript, React, Zustand, Vitest, EventSource/SSE, Next.js

## Global Constraints

- Only absolute POSIX paths may become local artifact tokens; malformed JSON, relative paths, query strings, fragments, and invalid field types remain plain text.
- Reuse the current `artifact` token and `postWebArtifactOpen(path)` rendering path; do not add an embedded HTML renderer.
- Keep Customer Agent SQLite sessions out of transcript observation.
- Keep current visibility handling, refresh serialization, history-tail merging, scroll preservation, and running-session polling fallback unchanged.
- Do not modify Server change-stream, watcher, Web gateway, file-preview permission, share, or download interfaces.

---

### Task 1: Parse Codex Visualize Markers as Artifacts

**Files:**
- Modify: `packages/desktop/renderer/lib/markdown-links.ts`
- Unit tests: `packages/desktop/renderer/lib/markdown-links.test.ts`

**Interfaces:**
- Consumes: existing `parseArtifactTarget(target: string)` validation and `RichInlineToken` union.
- Produces: `parseRichInlineTokens(text: string): RichInlineToken[]` entries shaped as `{ type: "artifact"; label: string; path: string; raw: string }` for valid Codex visualize markers.

- [x] **Step 1: Inspect the existing tokenizer ordering and validation**

Read: `packages/desktop/renderer/lib/markdown-links.ts`, `packages/desktop/renderer/lib/markdown-links.test.ts`

Confirm: Markdown links, file citations, and inline code are collected as indexed matches, sorted by source position, and overlap is suppressed through the shared cursor.

- [x] **Step 2: Add a structured visualize marker parser**

Add the private-use delimiter pattern with escaped code points and parse its JSON payload through `JSON.parse`:

```ts
const CODEX_VISUALIZE_PATTERN = /\uE200visualize\uE202([^\uE201\n]+)\uE201/g;

function parseCodexVisualize(payloadSource: string): { path: string; label: string } | null {
  try {
    const payload: unknown = JSON.parse(payloadSource);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const { path, title, mode } = payload as Record<string, unknown>;
    if (typeof path !== "string" || (title !== undefined && typeof title !== "string")) return null;
    if (mode !== undefined && typeof mode !== "string") return null;
    const artifact = parseArtifactTarget(path);
    if (!artifact || artifact.line !== undefined) return null;
    const label = title?.trim() || artifact.path.slice(artifact.path.lastIndexOf("/") + 1) || artifact.path;
    return { path: artifact.path, label };
  } catch {
    return null;
  }
}
```

Include visualize matches in `InlineLinkMatch`, emit the existing `artifact` token for valid payloads, and emit the complete raw marker as `text` for invalid payloads. Preserve position ordering so outer links or code spans continue to suppress overlapping inner matches.

- [x] **Step 3: Add focused tokenizer regressions**

Add tests using `\uE200`, `\uE202`, and `\uE201` string escapes:

```ts
expect(parseRichInlineTokens(
  '\uE200visualize\uE202{"path":"/tmp/demo.html","mode":"wide","title":"原型图"}\uE201',
)).toEqual([{
  type: "artifact",
  label: "原型图",
  path: "/tmp/demo.html",
  raw: '\uE200visualize\uE202{"path":"/tmp/demo.html","mode":"wide","title":"原型图"}\uE201',
}]);
```

Also assert basename fallback, invalid JSON, relative path, query/fragment path, non-string `title`/`mode`, and a marker inside inline code. Invalid values must remain one plain-text token containing their exact input.

### Task 2: Observe Transcript Changes for Locally Owned Native Runs

**Files:**
- Modify: `packages/desktop/renderer/lib/native-session-view-state.ts`
- Unit tests: `packages/desktop/renderer/lib/native-session-view-state.test.ts`
- Regression tests: `packages/desktop/renderer/lib/session-history.test.ts`
- Structural regression: `packages/desktop/renderer/components/ChatHistoryStyle.test.ts`

**Interfaces:**
- Consumes: `NativeSessionViewState`, selected `targetSessionId`, and `ChatView`'s existing `observeSession` effect.
- Produces: `shouldFollowNativeHistory(session, targetSessionId, runningSessionId): boolean`, returning true for every selected non-Customer-Agent native session regardless of local ownership.

- [x] **Step 1: Update the native history-follow predicate**

Keep the existing signature to avoid caller churn, but mark the now-unused third parameter with a leading underscore:

```ts
export function shouldFollowNativeHistory(
  session: NativeSessionViewState | null | undefined,
  targetSessionId: string | null,
  _runningSessionId: string | null,
): boolean {
  return Boolean(targetSessionId && session && session.agentType !== "customer-agent");
}
```

This makes the existing `ChatView` effect subscribe locally owned runs without modifying EventSource, refresh, merge, polling, or visibility logic.

- [x] **Step 2: Update predicate tests for the new ownership contract**

Replace the locally owned exclusion assertion with:

```ts
expect(shouldFollowNativeHistory({
  agentType: "codex",
  status: "running",
  occupancy: "owned-by-customer-agent",
}, "session-1", "session-1")).toBe(true);
```

Add or retain coverage that external running, external idle, and available idle Codex/Claude Code/OpenCode sessions return true while missing sessions, missing target IDs, and `customer-agent` sessions return false.

- [x] **Step 3: Confirm history reconciliation remains stable**

Run the existing `mergeRefreshedSessionHistory` cases without changing production merge behavior. Ensure the suite still proves preservation of older pages, queued messages, stable IDs, optimistic images, tool regrouping, and duplicate final-answer prevention.

- [x] **Step 4: Confirm ChatView still wires observation to reconciliation**

Retain the structural assertion in `ChatHistoryStyle.test.ts` that `ChatView` calls `shouldFollowNativeHistory(sessionSummary, targetSid, runningSessionId)` and uses `observeSession` to trigger `refreshLatestHistory`. No component restructure is required.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/renderer/lib/markdown-links.test.ts \
  packages/desktop/renderer/lib/native-session-view-state.test.ts \
  packages/desktop/renderer/lib/session-history.test.ts \
  packages/desktop/renderer/components/ChatHistoryStyle.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts \
  packages/server/lib/native-session-change-monitor.test.ts \
  packages/server/app/api/sessions/[id]/changes/route.test.ts
bunx tsc --noEmit -p packages/desktop/tsconfig.json
bun run --cwd packages/webapp typecheck
bunx tsc --noEmit -p packages/server/tsconfig.json
```

Result: 7 Vitest files and 90 tests passed. Desktop, WebApp, and Server TypeScript checks exited successfully.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
