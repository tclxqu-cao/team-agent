import { appendHarnessJobOutput } from "./deepseek-harness-job-codec.js";
import { harnessRecord, type HarnessConnection, type HarnessRecord, type HarnessStream } from "./deepseek-harness-client.js";
import { RuntimeSessionError } from "./types.js";
import type { RuntimeBackgroundJob, RuntimeBackgroundJobOutput, RuntimeBackgroundJobStopResult } from "./background-jobs.js";

const outputLimit = 16_384;
const statuses = new Set(["running", "stopping", "completed", "killed", "failed"]);

function view(row: HarnessRecord): RuntimeBackgroundJob {
  const output = harnessRecord(row.output);
  if (typeof row.id !== "string" || !row.id || typeof row.label !== "string"
    || !statuses.has(String(row.status)) || typeof row.startedAt !== "number"
    || !Number.isFinite(row.startedAt) || !Number.isSafeInteger(output.total) || Number(output.total) < 0) {
    throw new RuntimeSessionError("DeepSeek Harness 后台任务数据无效", "NATIVE_PROTOCOL_ERROR");
  }
  return {
    id: row.id, label: row.label, kind: typeof row.kind === "string" ? row.kind : "task",
    scope: row.owner == null ? "shared" : "session",
    status: row.status as RuntimeBackgroundJob["status"], startedAt: row.startedAt,
    ...(typeof row.finishedAt === "number" ? { finishedAt: row.finishedAt } : {}),
    ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
    outputBytes: Number(output.total), canStop: row.status === "running",
  };
}

/** Reads observer snapshots; the model's consuming job_output cursor is untouched. */
export class HarnessJobControl {
  constructor(private readonly client: HarnessConnection, private readonly sessionId: string) {}

  private open(endpoint: string, request: HarnessRecord): Promise<HarnessStream> {
    if (!this.client.open) throw new RuntimeSessionError("当前 Harness 不支持后台任务管理", "OPERATION_NOT_SUPPORTED");
    return this.client.open(endpoint, { request });
  }

  private visible(row: HarnessRecord): boolean {
    return row.owner == null || row.owner === this.sessionId;
  }

  private async rows(): Promise<HarnessRecord[]> {
    const stream = await this.open("job/list", { sessionId: this.sessionId });
    try {
      for await (const frame of stream.values) {
        if (frame.type !== "rows" || !Array.isArray(frame.jobs)) break;
        return frame.jobs.map(harnessRecord).filter(row => this.visible(row));
      }
      throw new RuntimeSessionError("DeepSeek Harness 后台任务列表无效", "NATIVE_PROTOCOL_ERROR");
    } finally { stream.close(); }
  }

  private async find(jobId: string): Promise<HarnessRecord> {
    const row = (await this.rows()).find(item => item.id === jobId);
    if (!row) throw new RuntimeSessionError("后台任务不存在或不属于当前会话", "BACKGROUND_JOB_NOT_FOUND");
    return row;
  }

  async list(): Promise<RuntimeBackgroundJob[]> {
    return (await this.rows()).map(view).sort((a, b) => {
      const active = (job: RuntimeBackgroundJob) => job.status === "running" || job.status === "stopping";
      return Number(active(b)) - Number(active(a)) || b.startedAt - a.startedAt;
    });
  }

  async output(jobId: string): Promise<RuntimeBackgroundJobOutput> {
    const row = await this.find(jobId);
    const initial = view(row);
    const from = Math.max(0, initial.outputBytes - outputLimit);
    const stream = await this.open("job/follow", { sessionId: this.sessionId, jobId, from });
    let job = initial;
    let output = "";
    let through: number | null = null;
    let truncated = from > 0;
    try {
      for await (const frame of stream.values) {
        if (frame.type === "opened" || frame.type === "status") {
          const current = harnessRecord(frame.job);
          if (current.id !== jobId || !this.visible(current)) throw new RuntimeSessionError("后台任务已不可见", "BACKGROUND_JOB_NOT_FOUND");
          job = view(current);
          if (frame.type === "status") break;
          through = job.outputBytes;
          if (!Number.isSafeInteger(frame.from) || Number(frame.from) < 0) throw new Error("后台任务输出游标无效");
          truncated ||= Number(frame.from) > 0;
          // A silent, still-running command must not block the phone's request.
          if (Number(frame.from) >= through) break;
        } else if (frame.type === "output" && through !== null) {
          if (!Number.isSafeInteger(frame.next) || Number(frame.next) < 0) throw new Error("后台任务输出游标无效");
          output = appendHarnessJobOutput(output, frame);
          truncated ||= frame.lossy === true;
          if (Number(frame.next) >= through) break;
        } else throw new RuntimeSessionError("后台任务输出帧无效", "NATIVE_PROTOCOL_ERROR");
      }
      if (through === null) throw new RuntimeSessionError("后台任务输出快照缺失", "NATIVE_PROTOCOL_ERROR");
      return { job, output, truncated };
    } finally { stream.close(); }
  }

  async stop(jobId: string): Promise<RuntimeBackgroundJobStopResult> {
    const job = view(await this.find(jobId));
    if (!["running", "stopping"].includes(job.status)) return { outcome: "already-finished" };
    const result = harnessRecord(await this.client.request("job/kill", { request: { sessionId: this.sessionId, jobId } }));
    if (result.outcome !== "requested" && result.outcome !== "already-finished") {
      throw new RuntimeSessionError("后台任务停止响应无效", "NATIVE_PROTOCOL_ERROR");
    }
    return { outcome: result.outcome };
  }
}
