import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkspaceChanges } from "./SessionTaskPanel";

afterEach(() => vi.unstubAllGlobals());
function service(status: number, body: string) {
  const request = vi.fn().mockResolvedValue({ status, body });
  vi.stubGlobal("window", { sharedServiceApi: { request } });
  return request;
}

describe("workspace change transport", () => {
  it("explains an old backend's HTML 404 without treating it as malformed Git data", async () => {
    service(404, "<!DOCTYPE html><title>404</title>");
    await expect(fetchWorkspaceChanges("/repo")).rejects.toThrow("当前后台尚未提供变更接口");
  });

  it("uses the selected desktop service and preserves the exact directory", async () => {
    const snapshot = { repository: true, root: "/repo", branch: "main", files: [] };
    const request = service(200, JSON.stringify(snapshot));
    expect(await fetchWorkspaceChanges("/中文 目录")).toEqual(snapshot);
    expect(request).toHaveBeenCalledWith(`/api/workspace-changes?${new URLSearchParams({ path: "/中文 目录" })}`, "GET");
  });

  it("distinguishes permission errors and rejects an invalid successful response", async () => {
    service(403, "Forbidden");
    await expect(fetchWorkspaceChanges("/repo")).rejects.toThrow("没有读取变更的权限");
    service(200, JSON.stringify({ ok: true }));
    await expect(fetchWorkspaceChanges("/repo")).rejects.toThrow("数据格式不正确");
    service(200, "null");
    await expect(fetchWorkspaceChanges("/repo")).rejects.toThrow("数据格式不正确");
  });

  it("uses same-origin HTTP in the web and phone clients", async () => {
    vi.stubGlobal("window", {});
    const snapshot = { repository: false, root: null, branch: null, files: [] };
    const fetch = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify(snapshot) });
    vi.stubGlobal("fetch", fetch);
    expect(await fetchWorkspaceChanges("/repo")).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledWith("/api/workspace-changes?path=%2Frepo", { cache: "no-store" });
  });
});
