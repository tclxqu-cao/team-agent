import type { AgentEvent, Message, NativeSubagentActivity } from "@agent/core";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { workBuddyText } from "./workbuddy-session-catalog.js";

interface Task { activity: NativeSubagentActivity; streamedText: string }
const status = (value: unknown): NativeSubagentActivity["status"] | undefined => value === "running" ? "running"
  : value === "completed" ? "completed" : value === "failed" ? "failed"
  : value === "killed" || value === "cancelled" || value === "stopped" ? "stopped" : undefined;

/** Native WorkBuddy child streams share the parent's channel, not its answer. */
export class WorkBuddySubagentTracker {
  private readonly tasks = new Map<string, Task>();

  stopActive(terminal: "failed" | "stopped"): AgentEvent[] {
    return [...this.tasks.values()].flatMap(task => {
      if (task.activity.status !== "running") return [];
      task.activity = { ...task.activity, status: terminal };
      return [this.update(task)];
    });
  }

  consume(packet: NativeJsonPacket): AgentEvent[] {
    const parentId = typeof packet.parent_tool_use_id === "string" ? packet.parent_tool_use_id : undefined;
    let task = typeof packet.task_id === "string" ? this.tasks.get(packet.task_id) : undefined;
    if (packet.type === "system" && packet.subtype === "task_started" && typeof packet.task_id === "string"
      && typeof packet.tool_use_id === "string") {
      task ??= [...this.tasks.values()].find(value => value.activity.parentToolCallId === packet.tool_use_id);
      task ??= { activity: { taskId: packet.task_id, parentToolCallId: packet.tool_use_id,
        agentName: typeof packet.task_type === "string" ? packet.task_type : undefined,
        description: typeof packet.description === "string" ? packet.description : "WorkBuddy 子任务",
        status: "running", messages: [] }, streamedText: "" };
      if (task.activity.taskId !== packet.task_id) this.tasks.delete(task.activity.taskId);
      task.activity = { ...task.activity, taskId: packet.task_id,
        agentName: typeof packet.task_type === "string" ? packet.task_type : task.activity.agentName };
      this.tasks.set(packet.task_id, task);
    }
    if (!task && parentId) task = [...this.tasks.values()].find(value => value.activity.parentToolCallId === parentId);
    if (!task && parentId) {
      task = { activity: { taskId: parentId, parentToolCallId: parentId, description: "WorkBuddy 子任务",
        status: "running", messages: [] }, streamedText: "" };
      this.tasks.set(parentId, task);
    }
    if (packet.type === "system" && task) {
      const patch = nativeRecord(packet.patch);
      task.activity = { ...task.activity,
        status: status(packet.status ?? patch.status) ?? task.activity.status,
        description: typeof packet.description === "string" ? packet.description : task.activity.description,
        summary: typeof packet.summary === "string" ? packet.summary : task.activity.summary,
        lastToolName: typeof packet.last_tool_name === "string" ? packet.last_tool_name : task.activity.lastToolName,
      };
      return [this.update(task)];
    }
    if (task && parentId) {
      if (packet.type === "stream_event") {
        const event = nativeRecord(packet.event);
        const delta = nativeRecord(event.delta);
        if (delta.type !== "text_delta" || typeof delta.text !== "string" || !delta.text) return [];
        const previous = task.activity.messages.at(-1);
        task.activity = { ...task.activity, messages: task.streamedText && previous?.role === "assistant"
          ? [...task.activity.messages.slice(0, -1), { ...previous, content: previous.content + delta.text }]
          : [...task.activity.messages, { role: "assistant", content: delta.text }] };
        task.streamedText += delta.text;
      } else if (packet.type === "assistant") {
        const content = nativeRecord(packet.message).content;
        const text = workBuddyText(content);
        const suffix = text.startsWith(task.streamedText) ? text.slice(task.streamedText.length) : task.streamedText ? "" : text;
        const toolCalls = Array.isArray(content) ? content.map(nativeRecord).flatMap(part => part.type === "tool_use" && typeof part.id === "string"
          ? [{ id: part.id, name: String(part.name ?? "WorkBuddy tool"), arguments: nativeRecord(part.input) }] : []) : [];
        if (suffix || toolCalls.length) task.activity = { ...task.activity,
          messages: [...task.activity.messages, { role: "assistant", content: suffix, ...(toolCalls.length ? { toolCalls } : {}) }] };
        task.streamedText = "";
      } else if (packet.type === "user") {
        const results = this.results(packet);
        if (!results.length) return [];
        task.activity = { ...task.activity, messages: [...task.activity.messages, ...results] };
      } else if (packet.type === "result") {
        task.activity = { ...task.activity, status: typeof packet.terminal_reason === "string" && packet.terminal_reason.startsWith("aborted")
          ? "stopped" : packet.is_error === true || packet.subtype !== "success" ? "failed" : "completed" };
      } else return [];
      return [this.update(task)];
    }
    return [];
  }

  private results(packet: NativeJsonPacket): Message[] {
    const content = nativeRecord(packet.message).content;
    return Array.isArray(content) ? content.map(nativeRecord).flatMap(part => part.type === "tool_result" && typeof part.tool_use_id === "string"
      ? [{ role: "tool" as const, toolCallId: part.tool_use_id, content: workBuddyText(part.content), isError: part.is_error === true }] : []) : [];
  }

  private update(task: Task): AgentEvent {
    return { type: "native_subagent_update", activity: { ...task.activity, messages: task.activity.messages.map(message => ({ ...message })) } };
  }
}
