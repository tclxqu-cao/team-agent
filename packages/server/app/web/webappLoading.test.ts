import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const webappMainSource = readFileSync(new URL("../../../webapp/src/main.tsx", import.meta.url), "utf8");
const sharedCss = readFileSync(new URL("../../../desktop/renderer/styles/global.css", import.meta.url), "utf8");

describe("webapp shell loading state", () => {
  it("keeps loading feedback in the outer shell until the webapp signals ready", () => {
    expect(pageSource).toContain("readWebappReadyMessage(");
    expect(pageSource).toContain("setWebappReady(true)");
    expect(pageSource).toContain('className={`webapp-boot${webappReady ? " is-ready" : ""}`}');
    expect(pageSource).toContain("正在唤醒工作区");
    expect(webappMainSource).toContain("announceWebappReady()");
  });

  it("does not block the shared renderer on a remote font stylesheet", () => {
    expect(sharedCss).not.toContain("fonts.googleapis.com");
    expect(sharedCss).not.toMatch(/^\s*@import\b/m);
  });

  it("honors reduced motion for the loading indicator", () => {
    expect(pageSource).toContain(".webapp-boot-orbit,.webapp-boot-diamond { animation:none !important; }");
  });
});
