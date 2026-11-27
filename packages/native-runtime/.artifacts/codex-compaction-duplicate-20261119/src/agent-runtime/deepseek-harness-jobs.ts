import type { AgentEvent } from "@agent/core";
import { harnessRecord, type HarnessConnection, type HarnessRecord, type HarnessStream } from "./deepseek-harness-client.js";
import { appendHarnessJobOutput as appendOutput, harnessJobProgress as progress } from "./deepseek-harness-job-codec.js";

type ProgressEvent = Extract<AgentEvent, { type: "runtime_progress" }>;

/** Mirrors native job observers without consuming the model's job_output cursor. */
export class HarnessJobs {
  private stopped = false;
  private readonly streams = new Set<HarnessStream>();
  private readonly watchers = new Map<string, Promise<void>>();
  private readonly views = new Map<string, { job: HarnessRecord; output: string }>();
  constructor(private readonly client: HarnessConnection, private readonly sessionId: string,
    private readonly emit: (event: ProgressEvent) => void) {}

  private async open(endpoint: string, request: HarnessRecord): Promise<HarnessStream | null> {
    if (!this.client.open || this.stopped) return null;
    const stream = await this.client.open(endpoint, { request });
    if (this.stopped) { stream.close(); return null; }
    this.streams.add(stream);
    return stream;
  }

  private reportFailure(error: unknown): void {
    if (!this.stopped) this.emit({ type: "runtime_progress", progressId: "harness-job-observer", phase: "status",
      label: "后台任务进度连接中断", detail: error instanceof Error ? error.message : "请刷新会话重试" });
  }

  async snapshot(): Promise<ProgressEvent[]> {
    const events: ProgressEvent[] = [];
    try {
      const stream = await this.open("job/list", { sessionId: this.sessionId });
      if (!stream) return events;
      for await (const frame of stream.values) {
        if (frame.type !== "rows" || !Array.isArray(frame.jobs)) throw new Error("DeepSeek Harness 后台任务列表无效");
        const jobs = frame.jobs.map(harnessRecord).filter(job => job.owner === this.sessionId
          && ["running", "stopping"].includes(String(job.status)));
        for (const job of jobs) {
          let output = "";
          const follow = await this.open("job/follow", { sessionId: this.sessionId, jobId: job.id });
          if (follow) {
            let through = 0;
            try {
              for await (const value of follow.values) {
                if (value.type === "opened") {
                  through = Number(harnessRecord(harnessRecord(value.job).output).total);
                  if (!Number.isSafeInteger(through) || through < 0) throw new Error("DeepSeek Harness 任务输出偏移无效");
                  if (!through) break;
                } else if (value.type === "output" && Array.isArray(value.chunks)) {
                  output = appendOutput(output, value);
                  if (Number(value.next) >= through) break;
                } else if (value.type === "status") break;
                else throw new Error("DeepSeek Harness 任务输出帧无效");
              }
            } finally { follow.close(); this.streams.delete(follow); }
          }
          events.push(progress(job, output));
        }
        break;
      }
    } catch (error) { this.reportFailure(error); }
    finally { await this.close(); }
    return events;
  }

  async watch(): Promise<void> {
    let stream: HarnessStream | null = null;
    try {
      stream = await this.open("job/list", { sessionId: this.sessionId });
      if (!stream) return;
      for await (const frame of stream.values) {
        if (this.stopped) break;
        if (frame.type !== "rows" || !Array.isArray(frame.jobs)) throw new Error("DeepSeek Harness 后台任务列表无效");
        for (const raw of frame.jobs) {
          const job = harnessRecord(raw);
          // Ignore unowned host jobs and old settlements when attaching to a turn.
          if (job.owner !== this.sessionId || typeof job.id !== "string") continue;
          if (!this.views.has(job.id) && !["running", "stopping"].includes(String(job.status))) continue;
          const view = this.views.get(job.id) ?? { job, output: "" };
          view.job = job;
          this.views.set(job.id, view);
          // Settlements arrive on follow after its output is drained.
          if (["running", "stopping"].includes(String(job.status))) this.emit(progress(job, view.output));
          if (!this.watchers.has(job.id)) this.watchers.set(job.id, this.follow(job.id));
        }
      }
    } catch (error) { this.reportFailure(error); }
    finally { if (stream) { stream.close(); this.streams.delete(stream); } }
  }

  private async follow(jobId: string): Promise<void> {
    let stream: HarnessStream | null = null;
    try {
      stream = await this.open("job/follow", { sessionId: this.sessionId, jobId });
      if (!stream) return;
      for await (const frame of stream.values) {
        if (this.stopped) break;
        const view = this.views.get(jobId)!;
        if (frame.type === "opened" || frame.type === "status") {
          view.job = harnessRecord(frame.job);
        } else if (frame.type === "output" && Array.isArray(frame.chunks)) {
          view.output = appendOutput(view.output, frame);
        } else throw new Error("DeepSeek Harness 任务输出帧无效");
        this.emit(progress(view.job, view.output));
      }
    } catch (error) { this.reportFailure(error); }
    finally { if (stream) { stream.close(); this.streams.delete(stream); } }
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const stream of this.streams) stream.close();
    await Promise.all(this.watchers.values());
  }
}
