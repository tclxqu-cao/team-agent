import WebSocket from "ws";
export function isCurrentVoiceEvent(event, current) {
    return event.sessionId === current.sessionId && event.generation === current.generation;
}
export class VoiceServiceClient {
    constructor(options) {
        this.socket = null;
        this.current = null;
        this.ready = false;
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.token = options.token;
    }
    startAsr(start, onEvent, onDisconnect) {
        this.closeAsr();
        this.current = start;
        this.ready = false;
        const endpoint = new URL("/v1/asr", this.baseUrl);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
        const socket = new WebSocket(endpoint, { headers });
        this.socket = socket;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.terminate();
                reject(new Error("voice service ASR readiness timed out"));
            }, 5_000);
            const fail = (error) => {
                clearTimeout(timer);
                reject(error);
            };
            socket.once("error", fail);
            socket.once("close", () => {
                if (!this.ready) {
                    fail(new Error("voice service ASR closed before ready"));
                    return;
                }
                if (this.socket === socket) {
                    onDisconnect?.(new Error("voice service ASR disconnected"));
                }
            });
            socket.on("message", (data) => {
                let message;
                try {
                    message = JSON.parse(data.toString());
                }
                catch {
                    return;
                }
                if (message.type === "ready"
                    && message.sessionId === start.sessionId
                    && message.generation === start.generation) {
                    clearTimeout(timer);
                    this.ready = true;
                    resolve();
                    return;
                }
                if ((message.type === "keyword" || message.type === "partial" || message.type === "final" || message.type === "finished")
                    && this.current) {
                    const event = message;
                    if (isCurrentVoiceEvent(event, this.current))
                        onEvent(event);
                }
            });
            socket.once("open", () => {
                socket.send(JSON.stringify({ ...start, type: "start", sampleRate: 16_000 }));
            });
        });
    }
    sendPcm(pcm) {
        if (!this.socket || !this.ready || this.socket.readyState !== WebSocket.OPEN)
            return;
        this.socket.send(pcm, { binary: true });
    }
    finishAsr() {
        this.sendControl("finish");
    }
    resetAsr() {
        this.sendControl("reset");
    }
    stopAsr() {
        this.closeAsr();
    }
    sendControl(type) {
        if (!this.socket || !this.current || this.socket.readyState !== WebSocket.OPEN)
            return;
        this.socket.send(JSON.stringify({
            type,
            sessionId: this.current.sessionId,
            generation: this.current.generation,
        }));
    }
    closeAsr() {
        const socket = this.socket;
        if (socket && socket.readyState === WebSocket.OPEN)
            this.sendControl("stop");
        socket?.close();
        this.socket = null;
        this.current = null;
        this.ready = false;
    }
    close() {
        this.closeAsr();
    }
}
//# sourceMappingURL=voice-service-client.js.map