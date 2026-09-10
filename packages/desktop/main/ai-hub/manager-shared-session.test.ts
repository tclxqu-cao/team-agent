import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const managerSource = readFileSync(new URL("./manager.ts", import.meta.url), "utf8");
const sessionChoiceSource = readFileSync(new URL("./session-choice.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

describe("AIHubManager shared imported session", () => {
  it("routes every pane through the shared imported session only when an import is active", () => {
    expect(managerSource).toContain("resolveHubSessionPlan(siteId, this.getImportedProfilePath?.() ?? null)");
    expect(managerSource).toContain("session.fromPath(plan.profilePath)");
    expect(managerSource).toContain("partition: plan.partition");
    expect(sessionChoiceSource).toContain("partition: `persist:aihub-${siteId}`");
  });

  it("hands Google auth interception to the existing browser without requiring profile import", () => {
    expect(managerSource).toContain("if (this.requestExistingBrowserLogin(siteId)) return;");
    expect(managerSource).toContain("if (!this.requestBrowserLogin) return false;");
    // 未接入托管登录回调时保留系统浏览器兜底
    expect(managerSource).toContain('this.emit({ type: "google-auth-external", siteId })');
    expect(managerSource).toContain("shell.openExternal(siteUrl)");
  });

  it("uses the existing Chrome page rather than installing reauth cookies", () => {
    expect(managerSource).not.toContain("applyGoogleReauthCookies");
    expect(managerSource).toContain('this.chromeBridge!.request(siteId, "send-message"');
  });
});

describe("AI Hub profile import IPC boundary", () => {
  it("validates the fixed source registry before importing", () => {
    expect(indexSource).toContain("if (!isBrowserProfileSourceId(sourceId))");
    expect(indexSource).toContain('"unknown-profile-source"');
  });

  it("derives the source path in the main process and exposes only sanitized metadata", () => {
    expect(indexSource).toContain("listBrowserProfileSources()");
    expect(indexSource).toContain(".map(toSourceView)");
    // 渲染层永不提交文件系统路径或 Keychain 名称
    expect(indexSource).not.toContain("hub:import-profile-path");
  });

  it("performs startup maintenance before any pane can open", () => {
    expect(indexSource).toContain("profileImporter.prepareForStartup()");
    expect(indexSource).toContain("chromeHubBridge.start()");
    expect(indexSource).toContain("app.relaunch()");
  });
});
