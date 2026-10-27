import { describe, expect, it, vi } from "vitest";
import { AsyncEventQueue } from "./async-event-queue";
import { HarnessJobControl } from "./deepseek-harness-job-control";
import type { HarnessConnection, HarnessRecord } from "./deepseek-harness-client";

const job = { id: "bash-1", owner: "native", label: "render video", kind: "bash", status: "running", startedAt: 1000, output: { total: 0, earliest: 0 } };

function fixture(rows: HarnessRecord[] = [job], frames: HarnessRecord[] = []) {
  const output = new AsyncEventQueue<HarnessRecord>();
  frames.forEach(frame => output.push(frame));
  const closeList = vi.fn();
  const closeOutput = vi.fn(() => output.close());
  const client: HarnessConnection = {
    request: vi.fn().mockResolvedValue({ outcome: "requested" }), follow: vi.fn(), dispose: vi.fn(),
    open: vi.fn(async endpoint => endpoint === "job/list"
      ? { values: (async function* () { yield { type: "rows", jobs: rows }; })(), close: closeList }
      : { values: output, close: closeOutput }),
  };
  return { client, control: new HarnessJobControl(client, "native"), closeList, closeOutput };
}

describe("Harness human background task controls", () => {
  it("shows the native visible roster including shared and settled jobs, excluding another session", async () => {
    const f = fixture([job, { ...job, id: "shared", owner: undefined }, { ...job, id: "other", owner: "elsewhere" },
      { ...job, id: "done", status: "completed", finishedAt: 4000, startedAt: 2000 }]);
    expect(await f.control.list()).toMatchObject([
      { id: "bash-1", scope: "session", canStop: true },
      { id: "shared", scope: "shared", canStop: true },
      { id: "done", status: "completed", canStop: false },
    ]);
    expect(f.closeList).toHaveBeenCalledOnce();
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("returns immediately for a silent running job instead of waiting for its completion", async () => {
    const f = fixture([job], [{ type: "opened", job, from: 0 }]);
    expect(await f.control.output(job.id)).toMatchObject({ job: { status: "running" }, output: "", truncated: false });
    expect(f.closeOutput).toHaveBeenCalledOnce();
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("reads a bounded output tail with an independent observer cursor", async () => {
    const large = { ...job, output: { total: 20000, earliest: 500 } };
    const f = fixture([large], [
      { type: "opened", job: large, from: 3616 },
      { type: "output", chunks: [{ text: "Rendering 80%\n<script>" }], next: 20000 },
    ]);
    expect(await f.control.output(job.id)).toMatchObject({ output: "Rendering 80%\n<script>", truncated: true });
    expect(f.client.open).toHaveBeenCalledWith("job/follow", { request: { sessionId: "native", jobId: "bash-1", from: 3616 } });
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.closeOutput).toHaveBeenCalledOnce();
  });

  it("does not send a kill or open output for a job belonging to another session", async () => {
    const f = fixture([{ ...job, owner: "elsewhere" }]);
    await expect(f.control.stop(job.id)).rejects.toMatchObject({ code: "BACKGROUND_JOB_NOT_FOUND" });
    await expect(f.control.output(job.id)).rejects.toMatchObject({ code: "BACKGROUND_JOB_NOT_FOUND" });
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.client.open).toHaveBeenCalledTimes(2);
  });

  it("uses the human kill endpoint for only the selected task and preserves the native receipt", async () => {
    const f = fixture();
    expect(await f.control.stop(job.id)).toEqual({ outcome: "requested" });
    expect(f.client.request).toHaveBeenCalledOnce();
    expect(f.client.request).toHaveBeenCalledWith("job/kill", { request: { sessionId: "native", jobId: "bash-1" } });
  });

  it("does not stop an already settled job", async () => {
    const f = fixture([{ ...job, status: "killed" }]);
    expect(await f.control.stop(job.id)).toEqual({ outcome: "already-finished" });
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("does not claim a task stopped when the Host rejects the command", async () => {
    const f = fixture();
    vi.mocked(f.client.request).mockRejectedValue(new Error("Host disconnected"));
    await expect(f.control.stop(job.id)).rejects.toThrow("Host disconnected");
    expect(f.closeList).toHaveBeenCalledOnce();
  });
});
