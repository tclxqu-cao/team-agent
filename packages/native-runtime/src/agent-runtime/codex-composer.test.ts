import { describe, expect, it, vi } from "vitest";
import type { RpcNotification } from "./codex-app-server-client.js";
import { CodexComposerPredictions, loadCodexComposerCatalog } from "./codex-composer.js";

describe("Codex composer", () => {
  it("uses runtime skills and workspace file matches", async () => {
    const request = vi.fn(async (method: string) => method === "skills/list"
      ? { data: [{ skills: [
          { name: "maintainer", path: "/repo/maintainer/SKILL.md", description: "Maintain this repo", enabled: true },
          { name: "disabled", path: "/repo/disabled/SKILL.md", description: "", enabled: false },
        ] }] }
      : { files: [
          { path: "src/main.ts", match_type: "file" },
          { path: "src", match_type: "directory" },
          { path: "../external.ts", match_type: "file" },
          { path: "src/main.ts", match_type: "file" },
        ] });
    const client = { request } as never;
    await expect(loadCodexComposerCatalog(client, "/repo")).resolves.toEqual({
      skills: [{ name: "maintainer", description: "Maintain this repo" }], files: [],
    });
    await expect(loadCodexComposerCatalog(client, "/repo", "main")).resolves.toEqual({
      skills: [], files: ["src/main.ts"],
    });
    expect(request).toHaveBeenCalledWith("fuzzyFileSearch", {
      query: "main", roots: ["/repo"], cancellationToken: null,
    }, expect.any(Number));
  });

  it("deduplicates concurrent reads and matches both thread and turn before returning a suggestion", async () => {
    const listeners = new Set<(event: RpcNotification) => void>();
    const request = vi.fn(async () => ({}));
    const predictions = new CodexComposerPredictions({
      request: request as never,
      onNotification: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onExit: () => () => undefined,
    });
    predictions.completed("thread", "turn");
    const one = predictions.request("thread", "turn");
    const two = predictions.request("thread", "turn");
    const emit = (threadId: string, sourceTurnId: string, text: string) => {
      for (const listener of listeners) listener({
        method: "thread/prediction/updated", params: { threadId, sourceTurnId, result: { type: "completed", text } },
      });
    };
    emit("other-thread", "turn", "wrong thread");
    emit("thread", "other-turn", "wrong turn");
    emit("thread", "turn", "请跑一次回归测试。");
    expect(await Promise.all([one, two])).toEqual(["请跑一次回归测试。", "请跑一次回归测试。"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    predictions.clear("thread");
    await expect(predictions.request("thread", "turn")).resolves.toBeNull();
  });

  it("treats the declared but unimplemented prediction method as unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("thread/prediction/request is not implemented yet"));
    const predictions = new CodexComposerPredictions({
      request,
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
    });
    predictions.completed("thread", "turn");
    await expect(predictions.request("thread", "turn")).resolves.toBeNull();
    predictions.completed("thread", "next");
    await expect(predictions.request("thread", "next")).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
