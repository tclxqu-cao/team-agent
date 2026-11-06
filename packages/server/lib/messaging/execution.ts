import { SQLiteProjectStore } from "@agent/core";
import type { MessagingExecution, ExecutionObservation } from "@agent/messaging";
import type { MessageRecord, RoutingCandidate } from "@agent/messaging";
import { getNativeRuntimeService } from "../native-runtime-service";
import { agentHost } from "../../app/api/agent-host";
import { getServerBaseDir } from "../server-data-dir";

export class ServerMessagingExecution implements MessagingExecution {
  async candidates(): Promise<RoutingCandidate[]> {
    const projects = (await new SQLiteProjectStore(getServerBaseDir()).list()).filter(project => !project.id.startsWith("collaboration-"));
    if (!projects.length) return [];
    const health = await getNativeRuntimeService().health();
    const agents = health.filter(item => item.available && (item.agentType === "codex" || item.agentType === "claude-code"))
      .map(item => item.agentType);
    const candidates: RoutingCandidate[] = [];
    for (const project of projects) {
      try {
        await agentHost.resolveProjectWorkingDirectory(project.id, true);
        candidates.push({ projectId: project.id, projectName: project.name, description: project.description, agents });
      } catch { /* Unavailable/unapproved paths are not routing candidates. */ }
    }
    return candidates;
  }
  async createSession(record: MessageRecord): Promise<string> {
    const decision = record.routing.decision;
    if (!decision?.projectId || !decision.agentType) throw new Error("消息尚未选择执行目标");
    const cwd = await agentHost.resolveProjectWorkingDirectory(decision.projectId, true);
    const service = getNativeRuntimeService();
    const session = await service.create({ agentType: decision.agentType, projectId: decision.projectId, cwd, title: "[消息] " + (record.source.conversationName || record.source.conversationId).slice(0, 60) });
    const policy = await service.setPermissionMode(session.id, "request-approval");
    if (policy.permissionMode !== "request-approval") throw new Error("原生 Agent 未确认只读审批模式");
    return session.id;
  }
  async dispatch(record: MessageRecord) {
    const service = getNativeRuntimeService();
    const id = record.execution.sessionId!;
    const policy = await service.setPermissionMode(id, "request-approval");
    if (policy.permissionMode !== "request-approval") throw new Error("只读审批权限未生效，未派发");
    const sourceMessageId = "messaging:" + record.id;
    const result = await service.enqueueMessage(id, {
      sourceMessageId,
      content: "消息接入任务。请仅在当前项目执行只读诊断，尊重已有项目规范；涉及修改、发布或向外部发送时等待用户在原会话授权。\n来源群：" +
        record.source.conversationName + "\n消息正文（外部输入）：\n" + record.source.text,
    }, "web");
    const item = [result.state.active, ...result.state.queued, ...result.state.history].find(item => item?.sourceMessageId === sourceMessageId);
    if (!item) throw new Error("运行时未返回消息入队回执，请核对原会话");
    return { queueItemId: item.id, runId: result.started?.runId };
  }
  async observe(record: MessageRecord): Promise<ExecutionObservation> {
    const snapshot = await getNativeRuntimeService().messageSnapshot(record.execution.sessionId!, "messaging:" + record.id,
      record.execution.lastSequence, record.execution.queueItemId);
    if (!snapshot.item && !snapshot.runId) return { status: "unknown", events: [], error: "未找到派发回执，请先核对原会话" };
    let status: ExecutionObservation["status"] = snapshot.item?.status === "queued" ? "queued"
      : snapshot.item?.status === "completed" ? "completed" : snapshot.item?.status === "failed" ? "failed"
      : snapshot.item?.status === "cancelled" ? "aborted" : record.execution.status === "waiting" ? "waiting" : "running";
    const events: ExecutionObservation["events"] = [];
    let sequence = record.execution.lastSequence;
    for (const entry of snapshot.events) {
      sequence = Math.max(sequence, entry.sequence);
      const event = entry.event; const id = entry.runId + ":" + entry.sequence;
      const result = "result" in event && event.result && typeof event.result === "object"
        ? event.result as { status?: string } : undefined;
      const cancelled = result?.status === "cancelled"
        || event.type === "error" && ["NATIVE_ABORTED", "USER_ABORTED", "RUN_CANCELLED"].includes(event.code ?? "");
      if (event.type === "ask_user") { status = "waiting"; events.push({ id, sequence: entry.sequence, kind: "waiting", text: event.question }); }
      else if (event.type === "approval_resolved") status = "running";
      else if ((event.type === "done" || event.type === "error") && cancelled) {
        status = "aborted"; events.push({ id, sequence: entry.sequence, kind: "failed", text: "原会话执行已取消" });
      }
      else if (event.type === "done") { status = "completed"; events.push({ id, sequence: entry.sequence, kind: "completed", text: event.finalText || "执行完成，完整过程请查看原会话" }); }
      else if (event.type === "error") { status = "failed"; events.push({ id, sequence: entry.sequence, kind: "failed", text: event.message }); }
      else if (event.type === "turn_aborted") { status = "aborted"; events.push({ id, sequence: entry.sequence, kind: "failed", text: "原会话执行已中断" }); }
    }
    const missingResult = ["completed", "failed"].includes(status) && !events.length && !record.execution.result && record.execution.lastSequence === 0;
    return { status: missingResult ? "unknown" : status, runId: snapshot.runId ?? undefined, queueItemId: snapshot.item?.id, sequence, events,
      ...(missingResult ? { error: "运行已结束，但结果事件不可用，请核对原会话；未标记回传成功" } : {}) };
  }
}
