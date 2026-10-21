import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@agent/core";
import type { CodexDesktopConnection, DesktopTurn } from "./codex-desktop-tools.js";
import type { RuntimeRunOptions } from "./types.js";

/** One human send, followed through the original Desktop-owned thread. */
export class CodexDesktopContinuation {
  private sent = false;
  private readonly controller = new AbortController();

  constructor(private readonly connection: CodexDesktopConnection, private readonly pollMs = 1_000) {}

  close(): void { this.controller.abort(); this.connection.close(); }

  async *run(input: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    try {
      const before = await this.connection.read();
      const beforeUsers = new Set(before.turns.flatMap(turn => turn.items.filter(item => item.type === "userMessage").map(item => `${turn.id}:${item.id}`)));
      const emitted = new Map<string, string>();
      for (const turn of before.turns) for (const item of turn.items) {
        if (item.type === "agentMessage" && item.id) emitted.set(`${turn.id}:${item.id}`, item.text ?? "");
      }
      this.sent = true;
      await this.connection.send(input, { model: options?.model?.id, thinking: options?.reasoningEffort, callId: options?.brokerRunId });
      yield { type: "runtime_progress", progressId: "codex-desktop", phase: "status", label: "已发送到原会话", detail: "由 Codex 桌面端继续执行；审批和停止操作请在原客户端处理。" };
      let turnId: string | undefined;
      const acceptedAt = Date.now();
      let waiting = false;
      while (!this.controller.signal.aborted) {
        const snapshot = await this.connection.read();
        const turn = turnId ? snapshot.turns.find(turn => turn.id === turnId) : snapshot.turns.find(turn => turn.items.some(item =>
          item.type === "userMessage" && !beforeUsers.has(`${turn.id}:${item.id}`)
          && item.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n").trim() === input.trim(),
        ));
        if (turn) {
          turnId = turn.id;
          for (const item of turn.items) {
            if (item.type !== "agentMessage" || !item.id || typeof item.text !== "string") continue;
            const key = `${turn.id}:${item.id}`;
            const previous = emitted.get(key) ?? "";
            if (item.text.startsWith(previous) && item.text.length > previous.length) {
              yield { type: "text_chunk", text: item.text.slice(previous.length), itemId: item.id, turnId,
                messagePhase: item.phase === "commentary" ? "commentary" : "final_answer" };
            }
            emitted.set(key, item.text);
          }
          if (turn.status === "completed") {
            yield { type: "done", finalText: finalText(turn), forkPoint: { turnId } }; return;
          }
          if (turn.status === "failed" || turn.status === "interrupted") {
            yield { type: "error", code: "NATIVE_PROTOCOL_ERROR", message: turn.error?.message || "原会话执行已中断，请查看 Codex 桌面端。" }; return;
          }
        } else if (turnId) {
          throw new Error("原会话有较多新消息，请刷新查看执行结果；本次消息不会自动重发。");
        } else if (Date.now() - acceptedAt > 120_000 && snapshot.thread.status?.type !== "active") {
          throw new Error("消息已交给原客户端，但尚未观察到开始执行。请检查原会话的排队消息；本次消息不会自动重发。");
        }
        const nowWaiting = snapshot.thread.status?.activeFlags?.some(flag => /waiting.*(approval|input)/i.test(flag)) ?? false;
        if (nowWaiting && !waiting) {
          yield { type: "runtime_progress", progressId: "codex-desktop", phase: "status", label: "原会话正在等待确认", detail: "请在 Codex 桌面端回答或审批，手机会继续同步进度。" };
        }
        waiting = nowWaiting;
        await delay(this.pollMs, undefined, { signal: this.controller.signal });
      }
    } catch (error) {
      yield { type: "error", code: this.sent ? "DESKTOP_DELIVERY_UNCONFIRMED" : "RUNTIME_UNAVAILABLE",
        message: `${error instanceof Error ? error.message : String(error)}${this.sent ? " 请先查看原会话，避免重复发送。" : ""}` };
    } finally { this.connection.close(); }
  }
}

function finalText(turn: DesktopTurn): string {
  const messages = turn.items.filter(item => item.type === "agentMessage" && typeof item.text === "string");
  return (messages.filter(item => item.phase !== "commentary").at(-1) ?? messages.at(-1))?.text ?? "";
}
