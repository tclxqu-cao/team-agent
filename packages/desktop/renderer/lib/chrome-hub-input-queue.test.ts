import { describe, expect, it, vi } from "vitest";
import { createChromeInputQueue, chromeInputError } from "./chrome-hub-input-queue";

describe("Chrome pane input backpressure", () => {
  it("keeps only the newest queued motion and preserves subsequent clicks and text", async () => {
    let release!: () => void;
    const dispatch = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const queue = createChromeInputQueue(dispatch, vi.fn(), vi.fn());
    queue.push({ kind: "pointer", action: "move", x: 0, y: 0 });
    for (let i = 0; i < 100; i++) queue.push({ kind: "pointer", action: "move", x: i / 100, y: .5 });
    queue.push({ kind: "pointer", action: "down", x: 1, y: .5 });
    queue.push({ kind: "pointer", action: "up", x: 1, y: .5 });
    queue.push({ kind: "text", text: "你好" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(5));
    expect(dispatch.mock.calls.slice(1).map(([input]) => input)).toEqual([
      { kind: "pointer", action: "move", x: .99, y: .5 },
      { kind: "pointer", action: "down", x: 1, y: .5 },
      { kind: "pointer", action: "up", x: 1, y: .5 },
      { kind: "text", text: "你好" },
    ]);
    queue.dispose();
  });

  it("reports a failed operation but still accepts later input", async () => {
    const error = vi.fn();
    const success = vi.fn();
    const queue = createChromeInputQueue(vi.fn().mockRejectedValueOnce(new Error("chrome-page-loading")).mockResolvedValue(undefined), error, success);
    queue.push({ kind: "text", text: "a" });
    queue.push({ kind: "text", text: "b" });
    await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledTimes(1);
    expect(chromeInputError(new Error("chrome-page-loading"))).toContain("正在加载");
    expect(chromeInputError(new Error("chrome-page-operation-failed"))).not.toContain("断开");
    queue.dispose();
  });
});
