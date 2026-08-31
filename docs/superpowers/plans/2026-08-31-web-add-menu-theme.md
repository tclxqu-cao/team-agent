# Web Add Menu Theme Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Web Shell add menu automatically match the active Pearl, Sci-fi, or Noir skin.

**Architecture:** Keep the existing React menu and theme propagation unchanged. Replace fixed light colors in the WebApp-only stylesheet with the semantic variables already defined by each skin, and protect the contract with a focused CSS source test.

**Tech Stack:** React 18, TypeScript, CSS custom properties, Vitest 2, Vite 5.

## Global Constraints

- Preserve the current menu placement, size, actions, and mobile control geometry.
- Use existing semantic skin variables; add no per-skin override blocks and no dependencies.
- Keep the change scoped to the browser Web Shell; Electron behavior remains unchanged.

---

### Task 1: Theme-Aware Add Menu

**Files:**
- Modify: `packages/webapp/src/presentation/browser-composer.css`
- Create: `packages/webapp/src/presentation/browser-composer.test.ts`

**Interfaces:**
- Consumes: `--bg-elevated`, `--border-default`, `--text-primary`, `--shadow-md`, `--control-hover`, and `--control-active` from the active `data-skin` theme.
- Produces: `.web-native-add-menu` and item interaction states whose computed colors follow the active skin.

- [x] **Step 1: Replace fixed menu colors with semantic tokens**

Change the menu surface, border, shadow, and label color to their existing CSS variable equivalents:

```css
.web-native-add-menu {
  border: 1px solid var(--border-default);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
}

.web-native-add-menu button {
  color: var(--text-primary);
}
```

- [x] **Step 2: Add skin-aware interaction feedback**

Add pointer hover and keyboard focus styles with `--control-hover`, plus pressed feedback with `--control-active`, while keeping the existing stable geometry:

```css
@media (hover: hover) {
  .web-native-add-menu button:hover {
    background: var(--control-hover);
  }
}

.web-native-add-menu button:focus-visible {
  background: var(--control-hover);
}

.web-native-add-menu button:active {
  background: var(--control-active);
}
```

- [x] **Step 3: Add a focused stylesheet contract test**

Read the stylesheet as text and assert that the menu rules contain all six semantic variables and no longer contain `background: #fff`, `color: #111827`, or the fixed `rgba(17,24,39,...)` menu shadow/border values.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./browser-composer.css", import.meta.url), "utf8");

describe("browser composer add menu theme", () => {
  it("uses semantic skin tokens instead of fixed light colors", () => {
    expect(css).toContain("background: var(--bg-elevated)");
    expect(css).toContain("color: var(--text-primary)");
    expect(css).not.toContain("background: #fff");
  });
});
```

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/webapp/src/presentation/browser-composer.test.ts
bun run --cwd packages/webapp typecheck
bun run --cwd packages/webapp build
```

Expected: the focused test passes, typecheck exits successfully, and the WebApp production build completes. Then verify at 390x844 that the open menu's computed surface, text, border, hover/focus, and active colors update under Pearl, Sci-fi, and Noir.
