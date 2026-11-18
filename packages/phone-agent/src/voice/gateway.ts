import { spawn } from "node:child_process";
import type { PhoneAgentConfig } from "../config.js";

/**
 * 语音网关（可选的独立进程）：复用 voice-service 的「小智」唤醒词 + 中文 ASR，
 * 把听到的指令转给 CA agent（/api/agent/run + SSE），并输出文字回答。
 *
 * 流程：mic(ffmpeg) → WS /v1/asr(mode=wake) → keyword 事件 → streaming ASR
 *      → final 文本 → POST /api/agent/run → GET /api/agent/stream (SSE)
 *      → done.finalText → 文字结果
 */

interface AsrEvent {
  type: "ready" | "keyword" | "partial" | "final" | "finished" | "error";
  sessionId?: string;
  generation?: number;
  strategy?: string;
  text?: string;
  message?: string;
}

/** Node22/Bun 自带 WebSocket；明确类型避免依赖 @types/ws。 */
type WsLike = WebSocket;

/** 旧版 Node 没有全局 WebSocket，给出可执行的修复提示而不是神秘崩溃。 */
function requireWebSocket(): typeof WebSocket {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  throw new Error(
    "当前运行时没有 WebSocket。请用 bun 运行（bun run --cwd packages/phone-agent voice），或升级到 Node 22+。",
  );
}

function connectWs(url: string): Promise<WsLike> {
  const WS = requireWebSocket();
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (ev) => reject(new Error(`WebSocket 连接失败 ${url}: ${String((ev as ErrorEvent).message ?? ev)}`)));
  });
}

export class VoiceGateway {
  private generation = 0;
  private busy = false;
  private stopMic: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly config: PhoneAgentConfig) {}

  /** 发指令给 CA agent 并等 SSE 终态，返回最终文本。 */
  async runAgentCommand(input: string): Promise<string> {
    const base = this.config.agentServerUrl.replace(/\/$/, "");
    const runResp = await fetch(`${base}/api/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 服务端写保护校验 Origin === protocol://host，服务间调用需自证
        Origin: new URL(base).origin,
      },
      body: JSON.stringify({ input, sessionId: this.config.voiceSessionId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!runResp.ok) {
      throw new Error(`agent/run HTTP ${runResp.status}: ${(await runResp.text()).slice(0, 200)}`);
    }
    const { sessionId, streamUrl } = (await runResp.json()) as { sessionId: string; streamUrl: string };

    const resp = await fetch(`${base}${streamUrl}`, {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`agent/stream HTTP ${resp.status}`);
    }
    let finalText = "";
    let fallbackText = "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!dataLine) continue;
        let event: { type?: string; finalText?: string; text?: string; message?: string; question?: string };
        try {
          event = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (event.type === "done") {
          finalText = event.finalText || fallbackText;
        } else if (event.type === "text_chunk") {
          fallbackText += event.text ?? "";
        } else if (event.type === "error") {
          throw new Error(`agent run 失败: ${event.message ?? "unknown"}`);
        } else if (event.type === "tool_call") {
          console.log(`[voice] agent 正在操作: ${(event as { toolCall?: { name?: string } }).toolCall?.name ?? ""}`);
        } else if (event.type === "ask_user") {
          // 输出追问后结束本轮，下一句话作为新输入继续（会话上下文仍在）
          finalText = event.question || (event as { message?: string }).message || "需要你的确认";
        }
      }
    }
    return finalText || fallbackText || "(agent 未返回内容)";
  }

  /** 处理一句唤醒后的指令。 */
  private async handleCommand(text: string): Promise<void> {
    if (this.busy) {
      console.warn("[voice] 上一条任务还在执行，请稍等");
      return;
    }
    this.busy = true;
    try {
      console.log(`[voice] 指令: ${text}`);
      const reply = await this.runAgentCommand(text);
      console.log(`[voice] 回复: ${reply}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[voice] 执行失败: ${msg}`);
    } finally {
      this.busy = false;
    }
  }

  /** 用 ffmpeg(avfoundation) 采集 16k mono f32le 麦克风推给 ASR。 */
  private startMic(ws: WsLike): void {
    const args = [
      "-f", "avfoundation",
      "-capture_cursor", "0",
      "-capture_mouse", "0",
      "-i", this.config.micDevice,
      "-ar", "16000",
      "-ac", "1",
      "-f", "f32le",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.on("data", (chunk: Buffer) => {
      if (ws.readyState === 1 /* OPEN */) ws.send(new Uint8Array(chunk));
    });
    proc.on("error", (err) => {
      console.error(`[voice] ffmpeg 启动失败（需要 brew install ffmpeg，或用 PHONE_MIC 指定设备）: ${err.message}`);
      process.exit(1);
    });
    this.stopMic = () => {
      proc.kill("SIGTERM");
    };
  }

  /** 主循环：连接 ASR（唤醒模式），断线自动重连。 */
  async start(): Promise<void> {
    console.log(
      `[voice] 唤醒词 "${this.config.wakeWord}" | agent=${this.config.agentServerUrl} | voice=${this.config.voiceServiceUrl}`,
    );
    while (!this.disposed) {
      try {
        const ws = await connectWs(`${this.config.voiceServiceUrl}/v1/asr`);
        this.generation += 1;
        const gen = this.generation;
        ws.send(JSON.stringify({
          type: "start",
          sessionId: this.config.voiceSessionId,
          generation: gen,
          sampleRate: 16_000,
          mode: "wake",
          wakeWord: this.config.wakeWord,
        }));
        this.startMic(ws);
        console.log("[voice] 待命中，说“小智”开始…");
        await new Promise<void>((resolve) => {
          ws.addEventListener("message", (ev) => {
            if (typeof ev.data !== "string") return;
            let event: AsrEvent;
            try {
              event = JSON.parse(ev.data) as AsrEvent;
            } catch {
              return;
            }
            if (event.generation !== undefined && event.generation !== gen) return;
            if (event.type === "ready") {
              console.log(`[voice] ASR ready (strategy=${event.strategy})`);
            } else if (event.type === "keyword") {
              console.log("[voice] 唤醒！");
            } else if (event.type === "final") {
              const text = (event.text ?? "").trim();
              if (text) void this.handleCommand(text);
            } else if (event.type === "error") {
              console.error(`[voice] ASR 错误: ${event.message}`);
            }
          });
          ws.addEventListener("close", () => resolve());
          ws.addEventListener("error", () => resolve());
        });
        this.stopMic?.();
        this.stopMic = null;
        if (!this.disposed) {
          console.log("[voice] 连接断开，3s 后重连");
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch (err) {
        if (this.disposed) return;
        console.error(`[voice] ${err instanceof Error ? err.message : err}，3s 后重连`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopMic?.();
  }
}

/** 单条模式：不连麦克风，直接把一段文本作为指令跑完整闭环（调试用）。 */
export async function runOnce(config: PhoneAgentConfig, text: string): Promise<void> {
  const gateway = new VoiceGateway(config);
  const reply = await gateway.runAgentCommand(text);
  console.log(`[voice] 回复: ${reply}`);
}
