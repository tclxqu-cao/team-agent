import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "../entities.js";
import type { RemoteToolStore } from "../../remote-tools/RemoteToolStore.js";

const schema = z.object({ action: z.string().min(1), payload: z.record(z.unknown()) });

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Options { store?: RemoteToolStore; projectId?: string; fetchImpl?: FetchLike; actionToken?: string; }

function safeJson(text: string): Record<string, unknown> { try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : { value: v }; } catch { return { text }; } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "Remote action failed"); }

export class RemoteProjectActionTool implements ITool {
  readonly name = "remote_project_action";
  readonly schema = schema;
  readonly parameters = { type: "object", properties: { action: { type: "string", description: "Registered remote action name, or remote_job_status to check a job." }, payload: { type: "object", description: "Small JSON payload for the registered remote action." } }, required: ["action", "payload"] };
  private readonly store?: RemoteToolStore;
  private readonly projectId: string;
  private readonly fetchImpl: FetchLike;
  private readonly actionToken?: string;

  constructor(options: Options = {}) { this.store = options.store; this.projectId = options.projectId ?? process.env.AGENT_PROJECT_ID ?? "default"; this.fetchImpl = options.fetchImpl ?? fetch; this.actionToken = options.actionToken ?? process.env.AGENT_ACTION_TOKEN; }

  get description(): string {
    const tools = this.store?.listEnabledTools(this.projectId) ?? [];
    const lines = tools.map((tool) => `- ${tool.scheme}: ${tool.purpose}`);
    return `Execute registered remote project actions by scheme. Never pass URLs; this tool resolves URLs from the registry. Use remote_job_status with {jobId} to poll results. Registered actions:\n${lines.length ? lines.join("\n") : "No remote actions are registered."}`;
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };
    if (!this.store) return { toolCallId: "", content: "Remote tool registry is not configured", isError: true };
    if (parsed.data.action === "remote_job_status") return this.getJobStatus(parsed.data.payload);

    const projectId = this.projectId;
    const remoteTool = this.store.getTool(projectId, parsed.data.action);
    if (!remoteTool) return { toolCallId: "", content: `Unknown remote action: ${parsed.data.action}`, isError: true };

    try {
      const job = this.store.createJob(projectId, remoteTool.scheme, parsed.data.payload);
      void this.runJob(job.id, remoteTool.url, remoteTool.scheme, remoteTool.headers, parsed.data.payload);
      return { toolCallId: "", content: JSON.stringify({ status: "queued", jobId: job.id, message: "远程任务已提交" }) };
    } catch (error) {
      return { toolCallId: "", content: errorMessage(error), isError: true };
    }
  }

  private getJobStatus(payload: Record<string, unknown>): ToolResult {
    const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
    if (!jobId) return { toolCallId: "", content: "remote_job_status requires payload.jobId", isError: true };
    const job = this.store?.getJob(jobId);
    if (!job || job.projectId !== this.projectId) return { toolCallId: "", content: `Unknown remote job: ${jobId}`, isError: true };
    if (job.status === "succeeded") return { toolCallId: "", content: JSON.stringify({ status: job.status, result: job.responsePayload }) };
    if (job.status === "failed") return { toolCallId: "", content: JSON.stringify({ status: job.status, error: job.error }) };
    return { toolCallId: "", content: JSON.stringify({ status: job.status }) };
  }

  private async runJob(jobId: string, url: string, action: string, headers: Record<string, string>, payload: Record<string, unknown>): Promise<void> {
    try {
      this.store?.markJobRunning(jobId);
      const response = await this.fetchImpl(url, { method: "POST", headers: { ...headers, "content-type": "application/json", ...(this.actionToken ? { authorization: `Bearer ${this.actionToken}` } : {}) }, body: JSON.stringify({ action, payload }) });
      const text = await response.text();
      if (!response.ok) { this.markJobFailedSafely(jobId, `Remote action failed: ${response.status} ${text}`); return; }
      this.store?.markJobSucceeded(jobId, safeJson(text));
    } catch (error) {
      this.markJobFailedSafely(jobId, errorMessage(error));
    }
  }

  private markJobFailedSafely(jobId: string, error: string): void {
    try { this.store?.markJobFailed(jobId, error); } catch { /* avoid unhandled async failures from best-effort job status updates */ }
  }
}
