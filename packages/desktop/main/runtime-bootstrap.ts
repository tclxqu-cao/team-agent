import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface RuntimeBootstrapStatus { phase: "idle" | "installing" | "ready" | "error"; message: string }

/** Installs into the user's CLI data directory; never owns or stops the background service. */
export class DesktopRuntimeBootstrap {
  private state: RuntimeBootstrapStatus = { phase: "idle", message: "" };
  private pending: Promise<RuntimeBootstrapStatus> | null = null;
  constructor(private readonly packaged: boolean, private readonly resourcesPath: string, private readonly executable = process.execPath, private readonly spawnWorker: typeof spawn = spawn) {}
  status(): RuntimeBootstrapStatus { return { ...this.state }; }
  prepare(): Promise<RuntimeBootstrapStatus> {
    if (this.pending) return this.pending;
    if (!this.packaged) return Promise.resolve({ phase: "idle", message: "开发模式请先启动 agentroam 服务。" });
    this.state = { phase: "installing", message: "正在准备运行环境…" };
    this.pending = new Promise<RuntimeBootstrapStatus>(resolve => {
      let finished = false;
      let child: ChildProcess;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        if (success || this.state.phase !== "error") this.state = { phase: success ? "ready" : "error", message: success ? "运行组件已准备好，正在连接工作区…" : `${this.state.message.replace(/…$/, "")}未完成，请检查网络后重试。` };
        resolve(this.status());
      };
      try {
        child = this.spawnWorker(this.executable, [join(this.resourcesPath, "bootstrap/runtime-bootstrap.mjs")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      } catch { finish(false); return; }
      let buffer = "";
      child.stdout?.on("data", chunk => {
        buffer = (buffer + chunk).slice(-8192);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.error === "runtime-incompatible") this.state = { phase: "error", message: "当前安装包与运行组件版本不兼容，请下载配套的新版本。" };
            if (typeof value.message === "string" && value.message.length <= 160) this.state = { phase: "installing", message: value.message };
          } catch {}
        }
      });
      child.once("error", () => finish(false));
      child.once("exit", code => finish(code === 0));
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
