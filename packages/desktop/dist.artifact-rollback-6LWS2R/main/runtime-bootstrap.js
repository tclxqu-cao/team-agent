import { spawn } from "node:child_process";
import { join } from "node:path";
/** Installs into the user's CLI data directory; never owns or stops the background service. */
export class DesktopRuntimeBootstrap {
    constructor(packaged, resourcesPath, executable = process.execPath, spawnWorker = spawn) {
        this.packaged = packaged;
        this.resourcesPath = resourcesPath;
        this.executable = executable;
        this.spawnWorker = spawnWorker;
        this.state = { phase: "idle", message: "" };
        this.pending = null;
    }
    status() { return { ...this.state }; }
    prepare() {
        if (this.pending)
            return this.pending;
        if (!this.packaged)
            return Promise.resolve({ phase: "idle", message: "开发模式请先启动 agentroam 服务。" });
        this.state = { phase: "installing", message: "正在准备运行环境…" };
        this.pending = new Promise(resolve => {
            let finished = false;
            let child;
            const finish = (success) => {
                if (finished)
                    return;
                finished = true;
                if (success || this.state.phase !== "error")
                    this.state = { phase: success ? "ready" : "error", message: success ? "运行组件已准备好，正在连接工作区…" : `${this.state.message.replace(/…$/, "")}未完成，请检查网络后重试。` };
                resolve(this.status());
            };
            try {
                child = this.spawnWorker(this.executable, [join(this.resourcesPath, "bootstrap/runtime-bootstrap.mjs")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
            }
            catch {
                finish(false);
                return;
            }
            let buffer = "";
            child.stdout?.on("data", chunk => {
                buffer = (buffer + chunk).slice(-8192);
                let end;
                while ((end = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, end);
                    buffer = buffer.slice(end + 1);
                    try {
                        const value = JSON.parse(line);
                        if (value.error === "runtime-incompatible")
                            this.state = { phase: "error", message: "当前安装包与运行组件版本不兼容，请下载配套的新版本。" };
                        if (typeof value.message === "string" && value.message.length <= 160)
                            this.state = { phase: "installing", message: value.message };
                    }
                    catch { }
                }
            });
            child.once("error", () => finish(false));
            child.once("exit", code => finish(code === 0));
        }).finally(() => { this.pending = null; });
        return this.pending;
    }
}
//# sourceMappingURL=runtime-bootstrap.js.map