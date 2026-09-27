import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveFlowStudioEntryUrl } from "./flow-studio-entry";

const source = readFileSync(new URL("./flow-studio-entry.ts", import.meta.url), "utf8");

describe("flow-studio-entry", () => {
  it("fetches the server-provided entry url in the web shell", () => {
    expect(source).toContain('fetch("/api/flow-studio/config", { credentials: "same-origin" })');
    // 同步开窗保住用户手势，再异步填入口地址
    expect(source).toContain('window.open("", "_blank")');
    expect(source).toContain("win.location.href = entryUrl");
  });

  it("reads the entry url over the service ipc in the desktop runtime", () => {
    expect(source).toContain('service.request("/api/flow-studio/config", "GET")');
    expect(source).toContain("window.agentApi?.openExternal?.(entryUrl)");
  });

  it("degrades to null instead of throwing outside a browser runtime", async () => {
    await expect(resolveFlowStudioEntryUrl()).resolves.toBeNull();
  });
});
