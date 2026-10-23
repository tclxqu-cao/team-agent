import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./glass.css", import.meta.url), "utf8");

describe("glass skin stylesheet", () => {
  it("gives the directory agent switcher glass material without changing its geometry", () => {
    const selector = ':root[data-skin="glass"] .app-sidebar .agent-workspace-switcher:not(.is-vertical)';
    const surface = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    expect(surface).toContain("background: var(--glass-surface)");
    expect(surface).toContain("backdrop-filter: var(--glass-blur)");
    expect(css).toContain(`${selector} button.is-active`);
    expect(css).toContain(`${selector} button:hover:not(.is-unavailable)`);
    expect(surface).not.toMatch(/(?:padding|margin|height|width|gap)\s*:/);
  });

  it("does not change layout metrics or history message visibility", () => {
    const materialOnly = css.split('@media (max-width: 899px)')[0];
    expect(materialOnly).not.toMatch(/(?:^|[;{])\s*(?:padding(?:-\w+)?|margin(?:-\w+)?|width|height|display|position|opacity|filter)\s*:/m);
    expect(css).toContain("--chat-history-text: #263e48");
    expect(css).toContain(".chat-message-bubble--assistant, .message-card");
  });

  it("styles both portaled file and more buttons", () => {
    const mobile = css.split('@media (max-width: 899px)')[1];
    expect(mobile).toContain('.glass-mobile-actions :is(.ui-icon-button, .file-drawer-toggle)');
    expect(mobile).toContain('appearance: none');
    expect(mobile).toContain('padding: 0');
  });

  it("has solid fallbacks and respects reduced transparency", () => {
    expect(css).toContain("@supports not (backdrop-filter: blur(1px))");
    expect(css).toContain("prefers-reduced-transparency: reduce");
    expect(css).toContain("--glass-blur: none");
  });
});
