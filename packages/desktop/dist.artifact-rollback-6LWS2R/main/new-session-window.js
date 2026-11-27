import { randomUUID } from "node:crypto";
import { isAgentType } from "@agent/core";
export function newSessionWindowQuery(value) {
    if (!value || typeof value !== "object")
        throw new Error("Invalid new session window options");
    const options = value;
    if (!isAgentType(options.agentType))
        throw new Error("Invalid new session agent");
    if (options.workspacePath !== undefined && (typeof options.workspacePath !== "string"
        || options.workspacePath.length > 32768 || options.workspacePath.includes("\0"))) {
        throw new Error("Invalid new session directory");
    }
    return {
        newSessionWindow: "1",
        agent: options.agentType,
        ...(typeof options.workspacePath === "string" && options.workspacePath ? { cwd: options.workspacePath } : {}),
    };
}
/** Only app-owned renderer main frames share the broker; each owns its SSE handles. */
export class DesktopRendererWindows {
    constructor(stop) {
        this.stop = stop;
        this.windows = new Map();
    }
    register(window) {
        const contents = window.webContents;
        if (this.windows.has(contents))
            return;
        const streams = new Map();
        this.windows.set(contents, { window, streams });
        window.once("closed", () => {
            this.windows.delete(contents);
            for (const id of streams.values())
                this.stop(id);
            streams.clear();
        });
    }
    assertSender(event) {
        if (!this.windows.has(event.sender) || event.sender.isDestroyed()
            || event.senderFrame !== event.sender.mainFrame)
            throw new Error("Untrusted desktop sender");
    }
    streamId(event, id) {
        this.assertSender(event);
        if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id))
            throw new Error("Invalid stream request");
        const { streams } = this.windows.get(event.sender);
        let internalId = streams.get(id);
        if (!internalId) {
            internalId = randomUUID();
            streams.set(id, internalId);
        }
        return internalId;
    }
    stopStream(event, id) {
        this.assertSender(event);
        const { streams } = this.windows.get(event.sender);
        const internalId = streams.get(id);
        if (internalId) {
            streams.delete(id);
            this.stop(internalId);
        }
    }
}
//# sourceMappingURL=new-session-window.js.map