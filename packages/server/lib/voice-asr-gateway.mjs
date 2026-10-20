import { WebSocket, WebSocketServer } from "ws";

const MAX_FRAME_BYTES = 32 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;

/** Authenticated browser dictation transport; the ASR sidecar remains private. */
export function createVoiceAsrGateway({ pairing, serviceUrl = "http://127.0.0.1:17863", token = null }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("connection", (browser, principal) => {
    let upstream = null;
    let current = null;
    let ready = false;
    let finishing = false;
    let readinessTimer;
    const fail = (message) => {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: "error", message }));
        browser.close(1011, "dictation unavailable");
      }
      upstream?.terminate();
    };
    const lifetime = setTimeout(() => fail("单次语音输入已达 5 分钟，请重新开始"), 5 * 60_000);
    const authorization = setInterval(() => {
      if (!pairing.active(principal)) browser.close(4003, "device authorization expired");
    }, 5_000);
    browser.on("close", () => {
      clearTimeout(lifetime);
      clearTimeout(readinessTimer);
      clearInterval(authorization);
      upstream?.terminate();
    });
    browser.on("error", () => browser.terminate());
    browser.on("message", (data, binary) => {
      if (!pairing.active(principal)) { browser.close(4003, "device authorization expired"); return; }
      try {
        if (binary) {
          if (!ready || finishing || data.length === 0 || data.length % 4 !== 0) throw new Error("语音音频帧无效");
          if (upstream.bufferedAmount > MAX_BUFFER_BYTES) throw new Error("语音连接过慢，请重新开始");
          upstream.send(data, { binary: true });
          return;
        }
        const control = JSON.parse(data.toString());
        if (control.type === "start") {
          if (current || control.mode !== "dictation" || control.sampleRate !== 16_000
            || typeof control.sessionId !== "string" || !control.sessionId || control.sessionId.length > 128
            || !Number.isSafeInteger(control.generation) || control.generation < 0) throw new Error("语音启动参数无效");
          current = { sessionId: control.sessionId, generation: control.generation };
          const endpoint = new URL("/v1/asr", serviceUrl);
          endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
          upstream = new WebSocket(endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, maxPayload: MAX_FRAME_BYTES });
          readinessTimer = setTimeout(() => fail("本机语音服务连接超时"), 5_000);
          upstream.on("open", () => upstream.send(JSON.stringify({ type: "start", mode: "dictation", sampleRate: 16_000, ...current })));
          upstream.on("error", () => fail("本机语音服务不可用，请确认语音服务已启动"));
          upstream.on("close", () => {
            if (browser.readyState === WebSocket.OPEN) fail("本机语音服务连接已断开");
          });
          upstream.on("message", (raw, isBinary) => {
            if (browser.readyState !== WebSocket.OPEN) return;
            if (!pairing.active(principal)) { browser.close(4003, "device authorization expired"); return; }
            if (isBinary || browser.bufferedAmount > MAX_BUFFER_BYTES) { fail("语音返回连接异常，请重新开始"); return; }
            let event;
            try { event = JSON.parse(raw.toString()); } catch { fail("语音服务返回无效数据"); return; }
            if (event.type === "error") { fail("语音服务识别失败，请重新开始"); return; }
            if (event.sessionId !== current.sessionId || event.generation !== current.generation) return;
            if (event.type === "ready") { ready = true; clearTimeout(readinessTimer); }
            if (!["ready", "partial", "final", "finished"].includes(event.type)) return;
            browser.send(raw.toString());
            if (event.type === "finished") browser.close(1000, "finished");
          });
          return;
        }
        if (!ready || !current || control.sessionId !== current.sessionId || control.generation !== current.generation) throw new Error("语音控制会话无效");
        if (control.type === "stop") { browser.close(1000, "stopped"); return; }
        if (control.type !== "finish" || finishing) throw new Error("语音控制操作无效");
        finishing = true;
        upstream.send(JSON.stringify({ type: "finish", ...current }));
      } catch (error) { fail(error instanceof Error ? error.message : "语音请求无效"); }
    });
  });
  return {
    handleUpgrade(req, socket, head) {
      if (new URL(req.url, "http://gateway.local").pathname !== "/ws/voice") return false;
      socket.on("error", () => socket.destroy());
      const principal = pairing.authenticateUpgrade(req);
      if (!principal) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return true; }
      server.handleUpgrade(req, socket, head, (ws) => {
        pairing.track(ws, principal);
        server.emit("connection", ws, principal);
      });
      return true;
    },
    close() {
      for (const socket of server.clients) socket.terminate();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
