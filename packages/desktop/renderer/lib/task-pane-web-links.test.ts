import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlainWebLinkClick, requestTaskPaneWebLink, TASK_PANE_WEB_LINK_EVENT } from "./task-pane-web-links";

afterEach(() => vi.unstubAllGlobals());

describe("message links in empty desktop panes", () => {
  function desktop() {
    const target = Object.assign(new EventTarget(), { agentApi: { taskPageOpen: vi.fn() } });
    vi.stubGlobal("window", target);
    return target;
  }

  it("keeps ordinary navigation when no pane claims the link", () => {
    desktop();
    expect(requestTaskPaneWebLink("https://example.com/docs")).toBe(false);
  });

  it("reports a consumed URL only when an empty pane cancels the request", () => {
    const target = desktop();
    let url = "";
    target.addEventListener(TASK_PANE_WEB_LINK_EVENT, event => {
      url = (event as CustomEvent).detail.url;
      event.preventDefault();
    });
    expect(requestTaskPaneWebLink("https://example.com")).toBe(true);
    expect(url).toBe("https://example.com/");
    expect(requestTaskPaneWebLink("file:///etc/passwd")).toBe(false);
    expect(requestTaskPaneWebLink("javascript:alert(1)")).toBe(false);
  });

  it("preserves modifier clicks and browser/mobile links", () => {
    vi.stubGlobal("window", { agentApi: {} });
    expect(requestTaskPaneWebLink("https://example.com")).toBe(false);
    const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainWebLinkClick(plain)).toBe(true);
    for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) expect(isPlainWebLinkClick({ ...plain, [key]: true })).toBe(false);
    expect(isPlainWebLinkClick({ ...plain, button: 1 })).toBe(false);
  });

  it("lets a desktop web workspace claim links without requiring native browser APIs", () => {
    vi.stubGlobal("document", { body: { dataset: { webShell: "1" } } });
    const target = Object.assign(new EventTarget(), { agentApi: {} });
    vi.stubGlobal("window", target);
    // A phone has no enabled workspace listener, so its link keeps normal navigation.
    expect(requestTaskPaneWebLink("https://example.com")).toBe(false);
    target.addEventListener(TASK_PANE_WEB_LINK_EVENT, event => event.preventDefault());
    expect(requestTaskPaneWebLink("https://example.com")).toBe(true);
  });
});
