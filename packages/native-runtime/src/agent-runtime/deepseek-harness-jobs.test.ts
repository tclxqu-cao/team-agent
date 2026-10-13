import { describe, expect, it, vi } from "vitest";
import { HarnessJobs } from "./deepseek-harness-jobs.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import type { HarnessConnection, HarnessRecord } from "./deepseek-harness-client.js";
import type { AgentEvent } from "@agent/core";

const job = { id: "bash-1", owner: "native", kind: "bash", label: "render", status: "running",
  startedAt: 1, output: { total: 0, earliest: 0 } };

function fixture() {
  const roster = new AsyncEventQueue<HarnessRecord>();
  const output = new AsyncEventQueue<HarnessRecord>();
  const events: AgentEvent[] = [];
  const closes = [vi.fn(() => roster.close()), vi.fn(() => output.close())];
  const client: HarnessConnection = { request: vi.fn(), follow: vi.fn(), dispose: vi.fn(),
    open: vi.fn(async endpoint => endpoint === "job/list"
      ? { values: roster, close: closes[0] } : { values: output, close: closes[1] }) };
  const observer = new HarnessJobs(client, "native", event => events.push(event));
  return { roster, output, events, closes, client, observer };
}

describe("Harness background job observation", () => {
  it("streams progress and output before settlement without consuming or controlling the job", async () => {
    const f = fixture();
    const watching = f.observer.watch();
    f.roster.push({ type: "rows", jobs: [job, { ...job, id: "old", status: "completed" }, { ...job, id: "other", owner: "other" }] });
    await vi.waitFor(() => expect(f.client.open).toHaveBeenCalledWith("job/follow", { request: { sessionId: "native", jobId: "bash-1" } }));
    f.output.push({ type: "opened", job, from: 0 });
    f.output.push({ type: "output", chunks: [{ at: 0, text: "Rendering 25%\r", channel: "stdout" }], next: 14 });
    f.output.push({ type: "output", chunks: [{ at: 14, text: "Rendering 50%\n", channel: "stderr" }], next: 28 });
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ status: "running", output: "Rendering 25%\rRendering 50%\n" }));
    f.output.push({ type: "status", job: { ...job, status: "completed", finishedAt: 2001, detail: "exit code: 0" } });
    f.output.close();
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ status: "completed", elapsedSeconds: 2, output: expect.stringContaining("50%") }));
    await f.observer.close();
    await watching;
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.client.follow).not.toHaveBeenCalled();
    expect(f.client.open).toHaveBeenCalledTimes(2);
    f.closes.forEach(close => expect(close).toHaveBeenCalled());
  });

  it("bounds retained output and reports missing chunks", async () => {
    const f = fixture();
    const watching = f.observer.watch();
    f.roster.push({ type: "rows", jobs: [job] });
    await vi.waitFor(() => expect(f.client.open).toHaveBeenCalledTimes(2));
    f.output.push({ type: "output", chunks: [{ at: 0, text: "x".repeat(20000) }], next: 20000 });
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ output: expect.stringContaining("仅保留最新输出") }));
    const event = f.events.at(-1);
    expect(event?.type === "runtime_progress" && event.output!.length).toBeLessThan(16500);
    f.output.push({ type: "output", lossy: true, chunks: [{ at: 21000, text: "new" }], next: 21003 });
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ output: expect.stringContaining("部分输出已丢失") }));
    await f.observer.close(); await watching;
  });

  it("returns an active-job snapshot without waiting for new output", async () => {
    const f = fixture();
    f.roster.push({ type: "rows", jobs: [job] });
    f.output.push({ type: "opened", job, from: 0 });
    const events = await f.observer.snapshot();
    expect(events).toMatchObject([{ status: "running", output: "", detail: expect.stringContaining("等待输出") }]);
    expect(f.closes[0]).toHaveBeenCalled(); expect(f.closes[1]).toHaveBeenCalled();
  });

  it("reads only already-retained output when restoring an externally running job", async () => {
    const f = fixture();
    const active = { ...job, output: { total: 5, earliest: 0 } };
    f.roster.push({ type: "rows", jobs: [active] });
    f.output.push({ type: "opened", job: active, from: 0 });
    f.output.push({ type: "output", chunks: [{ at: 0, text: "hello" }], next: 5 });
    expect(await f.observer.snapshot()).toMatchObject([{ output: "hello", status: "running" }]);
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("reports an observation failure separately from the native run", async () => {
    const f = fixture();
    vi.mocked(f.client.open!).mockRejectedValue(new Error("observer unavailable"));
    await f.observer.watch();
    expect(f.events).toMatchObject([{ type: "runtime_progress", label: "后台任务进度连接中断", detail: "observer unavailable" }]);
    expect(f.client.request).not.toHaveBeenCalled();
    await f.observer.close();
  });

  it("closes a stream that opens after cancellation", async () => {
    const f = fixture();
    let release!: (stream: { values: AsyncEventQueue<HarnessRecord>; close: () => void }) => void;
    vi.mocked(f.client.open!).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const watching = f.observer.watch();
    await f.observer.close();
    release({ values: f.roster, close: f.closes[0] });
    await watching;
    expect(f.closes[0]).toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
});
