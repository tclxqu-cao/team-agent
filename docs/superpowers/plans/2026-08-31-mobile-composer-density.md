# Mobile Composer Density Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce mobile Web composer control weight and remove exact token counts from its inline context summary.

**Architecture:** Add a pure formatter and optional compact prop to the shared ContextUsageBar, enabled only by browser ChatView. Keep all geometry changes in the WebApp phone stylesheet so Electron layout remains unchanged.

**Tech Stack:** React 18, TypeScript, CSS media queries, Vitest 2, Vite 5, Next.js 14.

## Global Constraints

- Mobile Web add, send, and stop controls are 38px circles.
- Mobile Web add and send icons are both 18px.
- Inline mobile context summary shows percentage only; exact token counts remain in the detail popover.
- Electron retains its full context summary and existing control sizes.
- Add no dependencies.

---

### Task 1: Compact Context Summary

**Files:**
- Modify: `packages/desktop/renderer/components/ContextUsageBar.tsx`
- Modify: `packages/desktop/renderer/components/ContextUsageBar.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Produces: `formatContextUsageSummary(view: ContextUsageView, compact: boolean): string`.
- Consumes: `compact?: boolean` on `ContextUsageBar` and the existing `webShell` runtime flag.

- [x] **Step 1: Add the pure summary formatter**

Return `${view.percent}%` in compact mode. Preserve the full formatted token ratio for normal mode and `尚无模型请求` before the first request.

- [x] **Step 2: Enable compact mode only in Web Shell**

Pass `compact={webShell}` from ChatView without changing Electron callers.

- [x] **Step 3: Add focused formatter tests**

Assert `10K / 100K · 10%` in normal mode, `10%` in compact mode, and `0%` for compact mode before the first request.

### Task 2: Mobile Control Geometry

**Files:**
- Modify: `packages/webapp/src/presentation/browser-composer.css`
- Modify: `packages/webapp/src/presentation/web.css`

**Interfaces:**
- Consumes: `.web-native-add-button`, `.web-native-send-button`, `.web-native-stop-button`, and `.context-usage-ribbon__summary`.
- Produces: fixed 38px mobile controls, 18px add/send icons, and a compact percentage-width summary.

- [x] **Step 1: Reduce mobile controls**

Override all three Web-native controls to 38px at the phone breakpoint and normalize add/send SVGs to 18px.

- [x] **Step 2: Tighten the percentage summary slot**

Reduce the mobile summary minimum width from 96px to 28px and keep tabular numeric alignment.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/desktop/renderer/components/ContextUsageBar.test.ts
bun run --cwd packages/webapp typecheck
bun run --cwd packages/webapp build
bun run --cwd packages/server build
```

Expected: the focused tests pass, typecheck/build commands exit successfully, and the 390x844 mobile browser reports 38px controls, 18px icons, and a percentage-only inline context summary.
