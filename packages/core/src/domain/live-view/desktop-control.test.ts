import { describe, expect, it, vi } from "vitest";
import { DesktopControlCoordinator, DesktopObservationRequired } from "./desktop-control";

const firstRun = { sessionId: "session-a", runId: "run-a" };
const secondRun = { sessionId: "session-b", runId: "run-b" };

describe("desktop control", () => {
  it("keeps consecutive operations in the same lease and requires a new observation after a handoff", async () => {
    const desktop = new DesktopControlCoordinator();
    const execute = vi.fn(async () => "frame");
    await desktop.execute(firstRun, false, execute);
    const waiting = desktop.execute(secondRun, true, execute);
    const stale = expect(waiting).rejects.toBeInstanceOf(DesktopObservationRequired);
    expect(desktop.snapshot()).toEqual({ owner: { kind: "agent", run: firstRun }, queue: [secondRun] });
    await desktop.execute(firstRun, true, execute);
    expect(execute).toHaveBeenCalledTimes(2);

    desktop.endRun(firstRun.runId);
    await stale;
    expect(execute).toHaveBeenCalledTimes(2);
    await desktop.execute(secondRun, false, execute);
    await desktop.execute(secondRun, true, execute);
    expect(execute).toHaveBeenCalledTimes(4);
    desktop.endRun(secondRun.runId);
    expect(desktop.snapshot()).toEqual({ owner: null, queue: [] });
  });

  it("waits for an in-flight operation to settle before confirming a manual takeover", async () => {
    const desktop = new DesktopControlCoordinator();
    const abort = new AbortController();
    let finish!: () => void;
    const operation = desktop.execute(firstRun, false, () => new Promise<void>((resolve) => { finish = resolve; }), abort.signal);
    const cancelled = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    const viewer = desktop.requestViewerControl();
    const observe = vi.fn(async () => "next frame");
    const next = desktop.execute(secondRun, false, observe);
    abort.abort();
    desktop.endRun(firstRun.runId);
    expect(desktop.snapshot().owner).toEqual({ kind: "agent", run: firstRun });

    finish();
    await cancelled;
    const returnControl = await viewer;
    expect(desktop.snapshot()).toEqual({ owner: { kind: "viewer" }, queue: [secondRun] });
    expect(observe).not.toHaveBeenCalled();
    returnControl();
    await expect(next).resolves.toBe("next frame");
    desktop.endRun(secondRun.runId);
  });

  it("drops cancelled waiters and passes an idle lease to the next session", async () => {
    vi.useFakeTimers();
    try {
      const desktop = new DesktopControlCoordinator(40);
      const abort = new AbortController();
      const unused = vi.fn(async () => undefined);
      await desktop.execute(firstRun, false, async () => undefined);
      const cancelled = expect(desktop.execute(secondRun, false, unused, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
      abort.abort();
      await cancelled;
      const thirdRun = { sessionId: "session-c", runId: "run-c" };
      const next = desktop.execute(thirdRun, false, async () => "frame");
      await vi.advanceTimersByTimeAsync(40);
      await expect(next).resolves.toBe("frame");
      expect(unused).not.toHaveBeenCalled();
      expect(desktop.snapshot().owner).toEqual({ kind: "agent", run: thirdRun });
      desktop.endRun(thirdRun.runId);
    } finally {
      vi.useRealTimers();
    }
  });
});
