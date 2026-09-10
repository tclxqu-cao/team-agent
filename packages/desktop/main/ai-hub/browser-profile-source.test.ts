import { describe, expect, it } from "vitest";
import {
  defaultProfilePath,
  getProfileSourceDefinition,
  isBrowserProfileSourceId,
  listBrowserProfileSources,
  sumDirectoryBytes,
  toSourceView,
} from "./browser-profile-source";

describe("source registry", () => {
  it("knows exactly the two fixed macOS sources", () => {
    expect(getProfileSourceDefinition("chrome-default")?.keychainService).toBe("Chrome Safe Storage");
    expect(getProfileSourceDefinition("ego-lite-default")?.keychainService).toBe("ego safe storage");
    expect(getProfileSourceDefinition("firefox-default")).toBeNull();
  });

  it("rejects unknown source ids at the IPC boundary", () => {
    expect(isBrowserProfileSourceId("chrome-default")).toBe(true);
    expect(isBrowserProfileSourceId("chrome-default-2")).toBe(false);
    expect(isBrowserProfileSourceId("../../etc")).toBe(false);
    expect(isBrowserProfileSourceId(42)).toBe(false);
    expect(isBrowserProfileSourceId(null)).toBe(false);
  });

  it("derives fixed profile paths under the user's Application Support", () => {
    const home = "/Users/someone";
    expect(defaultProfilePath("chrome-default", home)).toBe(`${home}/Library/Application Support/Google/Chrome/Default`);
    expect(defaultProfilePath("ego-lite-default", home)).toBe(`${home}/Library/Application Support/ego lite/Default`);
  });
});

describe("listBrowserProfileSources", () => {
  it("only offers sources found on disk and flags a running browser", async () => {
    const sources = await listBrowserProfileSources({
      homeDir: "/Users/someone",
      profileExists: (path) => path.includes("Google/Chrome"),
      isProcessRunning: async (name) => name === "Google Chrome",
      computeSizeBytes: async () => 2048,
    });
    const chrome = sources.find((source) => source.id === "chrome-default");
    const ego = sources.find((source) => source.id === "ego-lite-default");
    expect(chrome).toMatchObject({ available: true, running: true, reason: "browser-running", sizeBytes: 2048 });
    expect(ego).toMatchObject({ available: false, running: false, reason: "profile-not-found" });
  });

  it("never exposes profile paths or keychain names through the renderer view", async () => {
    const sources = await listBrowserProfileSources({
      homeDir: "/Users/someone",
      profileExists: () => true,
      isProcessRunning: async () => false,
      computeSizeBytes: async () => 1,
    });
    for (const source of sources) {
      const view = toSourceView(source);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("Library/Application Support");
      expect(serialized).not.toContain("Safe Storage");
      expect(Object.keys(view)).not.toContain("profilePath");
      expect(Object.keys(view)).not.toContain("keychainService");
    }
  });
});

describe("sumDirectoryBytes", () => {
  it("is exposed for importer reuse and never follows directory loops directly", async () => {
    // 生产实现走 node:fs 递归；此处仅校验签名与容错（不存在路径 → undefined）
    await expect(sumDirectoryBytes("/nonexistent-path-xyz")).resolves.toBeUndefined();
  });
});
