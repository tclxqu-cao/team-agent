import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCliProgress, withoutCliProgress } from "../bin/cli-progress.mjs";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("CLI progress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps fast commands quiet and reports elapsed time for slow commands", async () => {
    const log = vi.fn();
    await withCliProgress("快速命令", () => undefined, { log });
    const pending = withCliProgress("启动服务", () => delay(6000), { log });
    await vi.advanceTimersByTimeAsync(799);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5001);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "… 启动服务（已等待 0 秒）", "… 启动服务（已等待 5 秒）",
    ]);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows only the active stage and pauses through nested terminal prompts", async () => {
    const log = vi.fn();
    const pending = withCliProgress("安装", async () => {
      await withCliProgress("等待服务", () => delay(1600));
      await withoutCliProgress(async () => {
        await withoutCliProgress(() => delay(1000));
        await delay(1000);
      });
      await delay(800);
    }, { log });
    await vi.advanceTimersByTimeAsync(1600);
    expect(log.mock.calls.map(([line]) => line)).toEqual(["… 等待服务（已等待 0 秒）"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(800);
    await pending;
    expect(log).toHaveBeenLastCalledWith("… 安装（已等待 4 秒）");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up on rejection and restores progress after prompt failure", async () => {
    const log = vi.fn();
    const error = new Error("failed");
    const pending = withCliProgress("启动", async () => {
      await expect(withoutCliProgress(async () => { throw error; })).rejects.toBe(error);
      await delay(1000);
      throw error;
    }, { log });
    const checked = expect(pending).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1000);
    await checked;
    expect(log).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ AGENTROAM_SERVICE: "1" }, { AGENTROAM_NO_PROGRESS: "1" }])("stays quiet for %j", async (environment) => {
    const log = vi.fn();
    const pending = withCliProgress("启动", () => delay(6000), { environment, log });
    await vi.advanceTimersByTimeAsync(6000);
    await pending;
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
