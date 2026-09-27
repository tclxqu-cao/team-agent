import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const authGateSource = readFileSync(new URL("./AuthGate.tsx", import.meta.url), "utf8");
const routeLayoutSource = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const bootCss = readFileSync(new URL("./neural-boot.css", import.meta.url), "utf8");
const rootLayoutSource = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
const webappMainSource = readFileSync(new URL("../../../webapp/src/main.tsx", import.meta.url), "utf8");
const sharedCss = readFileSync(new URL("../../../desktop/renderer/styles/global.css", import.meta.url), "utf8");

describe("webapp shell loading state", () => {
  it("keeps loading feedback in the outer shell until the webapp signals ready", () => {
    expect(pageSource).toContain("readWebappReadyMessage(");
    expect(pageSource).toContain("setWebappReady(true)");
    expect(pageSource).toContain("onWorkspaceReady()");
    expect(pageSource).not.toContain('className={`webapp-boot');
    expect(authGateSource).toContain("正在唤醒工作区");
    expect(authGateSource).toContain("children(auth, markWorkspaceReady)");
    expect(webappMainSource).toContain("announceWebappReady()");
  });

  it("does not block the shared renderer on a remote font stylesheet", () => {
    expect(sharedCss).not.toContain("fonts.googleapis.com");
    expect(sharedCss).not.toMatch(/^\s*@import\b/m);
  });

  it("paints the document dark before route CSS and client hydration", () => {
    expect(rootLayoutSource).toContain('const INITIAL_BACKGROUND = "#070a0b"');
    expect(rootLayoutSource).toContain('themeColor: INITIAL_BACKGROUND, colorScheme: "dark"');
    expect(rootLayoutSource).toContain('style={{ background: INITIAL_BACKGROUND, colorScheme: "dark" }}');
    expect(rootLayoutSource).toContain('background: INITIAL_BACKGROUND');
  });

  it("uses one skin-aware boot surface from server render through workspace readiness", () => {
    expect(routeLayoutSource).toContain('import "./neural-boot.css"');
    expect(routeLayoutSource).toContain("webConsoleStore.getPreferences(userId)?.theme");
    expect(routeLayoutSource).toContain('id="web-theme-root"');
    expect(pageSource).toContain('document.getElementById("web-theme-root")?.dataset.webTheme');
    expect(pageSource).toContain("useState<WebThemeId>(readInitialWebThemeId)");
    expect(bootCss).toContain("background: var(--ui-root-bg");
    expect(bootCss).toContain("var(--ui-tab-accent");
    expect(authGateSource).not.toContain("<style jsx>");
  });

  it("honors reduced motion for the loading indicator", () => {
    expect(bootCss).toContain(".neural-boot *::after { animation: none !important; }");
    expect(pageSource).toContain(".terminal-boot-spinner { animation:none !important; }");
  });
});
