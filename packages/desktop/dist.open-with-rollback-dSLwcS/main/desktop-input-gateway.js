import { spawn } from "node:child_process";
function defaultSpawn(path) {
    return spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
}
/** Gateway to the desktop-input Swift helper: JSON-lines requests over stdin/stdout. */
export class DesktopInputGateway {
    constructor({ helperPath, spawnImpl = defaultSpawn, lineTimeoutMs = 4_000, startSettleMs = 50, onStderr = () => undefined }) {
        this.process = null;
        this.buffer = "";
        this.sequence = 0;
        this.pending = new Map();
        this.startPromise = null;
        this.helperPath = helperPath;
        this.spawnImpl = spawnImpl;
        this.lineTimeoutMs = lineTimeoutMs;
        this.startSettleMs = startSettleMs;
        this.onStderr = onStderr;
    }
    start() {
        if (this.startPromise)
            return this.startPromise;
        this.startPromise = new Promise((resolve, reject) => {
            let child;
            try {
                child = this.spawnImpl(this.helperPath);
            }
            catch (error) {
                this.startPromise = null;
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            // spawn() reports a missing/blocked binary through the async "error"
            // event; an unhandled one crashes the main process with a modal dialog.
            let spawnError = null;
            child.stdout.on("data", (chunk) => this.#handleChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
            child.stderr.on("data", (chunk) => {
                const line = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
                if (line)
                    this.onStderr(line);
            });
            child.on("exit", () => this.#handleExit());
            child.on("error", (error) => {
                spawnError = error;
                this.#handleSpawnError(error);
            });
            this.process = child;
            // Settle past the tick the spawn error fires on so start() rejects with
            // it and enable() can surface it as a status error instead of crashing.
            setTimeout(() => {
                if (spawnError)
                    reject(spawnError);
                else
                    resolve();
            }, this.startSettleMs);
        });
        return this.startPromise;
    }
    async stop() {
        const child = this.process;
        this.process = null;
        this.startPromise = null;
        this.buffer = "";
        this.#failPending(new Error("desktop input helper is stopped"));
        child?.kill();
    }
    async checkAccessibility() {
        const response = await this.request({ op: "check" });
        return response.trusted === true;
    }
    async snapshotAccessibility() {
        const response = await this.request({ op: "ax_snapshot" });
        if (response.status === "ok" && response.observation && typeof response.observation === "object") {
            return { status: "ok", observation: response.observation };
        }
        const status = response.status === "denied" || response.status === "timeout"
            ? response.status
            : "unavailable";
        return { status, ...(typeof response.message === "string" ? { message: response.message } : {}) };
    }
    async performAccessibilityAction(revision, nodeId, action) {
        await this.request({ op: "ax_action", revision, nodeId, action });
    }
    async setAccessibilityText(revision, nodeId, text, replace) {
        await this.request({ op: "ax_text", revision, nodeId, text, replace });
    }
    async dispatch(command) {
        return this.request(command);
    }
    async request(payload) {
        const child = this.process;
        if (!child)
            throw new Error("desktop input helper is not running");
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("desktop input helper timed out"));
            }, this.lineTimeoutMs);
            this.pending.set(id, { resolve, reject, timer, op: String(payload.op) });
            child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
        });
    }
    #handleChunk(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line)
                this.#handleLine(line);
            newline = this.buffer.indexOf("\n");
        }
    }
    #handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        const id = Number(message.id);
        const request = this.pending.get(id);
        if (!request)
            return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        // Older bundled helpers omitted ok only for read-only hit-test replies.
        if (request.op === "hit-test" && message.ok === undefined && message.error === undefined && typeof message.editable === "boolean")
            message.ok = true;
        if (message.ok === true)
            request.resolve(message);
        else
            request.reject(Object.assign(new Error(String(message.error || "desktop input helper error")), typeof message.code === "string" ? { code: message.code } : {}));
    }
    #handleExit() {
        this.process = null;
        this.startPromise = null;
        this.buffer = "";
        this.#failPending(new Error("desktop input helper exited"));
    }
    #handleSpawnError(error) {
        this.process = null;
        this.startPromise = null;
        this.buffer = "";
        this.#failPending(new Error(`desktop input helper failed to start: ${error.message}`));
    }
    #failPending(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=desktop-input-gateway.js.map