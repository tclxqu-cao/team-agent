import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrowserLivePanel from "./BrowserLivePanel";

afterEach(() => vi.unstubAllGlobals());

describe("workspace remote desktop embedding", () => {
  it("renders the viewer in its pane without creating a modal portal", () => {
    vi.stubGlobal("document", { body: {} });
    const html = renderToStaticMarkup(createElement(BrowserLivePanel, { open: true, embedded: true, onClose: () => {} }));
    expect(html).toContain("browser-live-backdrop--embedded");
    expect(html).toContain('role="region"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain("browser-live-viewport");
  });
});
