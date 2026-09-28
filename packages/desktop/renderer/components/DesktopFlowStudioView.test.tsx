import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import DesktopFlowStudioView from "./DesktopFlowStudioView";

const preload = readFileSync(new URL("../../main/preload.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");

describe("DesktopFlowStudioView", () => {
  it("renders the native embedded-page shell with a top-left back action", () => {
    const html = renderToStaticMarkup(createElement(DesktopFlowStudioView, {
      entryUrl: "http://127.0.0.1:8788/auth/entry?token=test",
      onBack: () => {},
    }));

    expect(html).toContain('class="desktop-flow-studio-view"');
    expect(html).toContain('aria-label="返回 AgentRoam"');
    expect(html).toContain('class="desktop-flow-studio-topbar"');
    expect(html).toContain('class="desktop-flow-studio-content"');
    expect(html).not.toContain("<iframe");
  });

  it("uses dedicated IPC over the same WebContentsView manager as AI Hub", () => {
    expect(preload).toContain('flowStudioOpen: (url: string) => ipcRenderer.invoke("flow-studio:open", url)');
    expect(preload).toContain('ipcRenderer.invoke("flow-studio:set-bounds", rect)');
    expect(main).toContain("aiHubManager.openEmbeddedPage(FLOW_STUDIO_PAGE_ID, rawUrl)");
    expect(main).toContain("aiHubManager.setEmbeddedPageBounds(FLOW_STUDIO_PAGE_ID");
  });
});
