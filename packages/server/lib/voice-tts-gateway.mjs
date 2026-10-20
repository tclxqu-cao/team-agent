import { WebSocket, WebSocketServer } from "ws";

/** Paired browser devices can synthesize speech without receiving provider secrets. */
export function createVoiceTtsGateway({ pairing, serviceUrl = "http://127.0.0.1:17863", token = null }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on("connection", (browser, principal) => {
    let upstream;
    let current;
    let started = false;
    const fail = (message) => {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: "error", message, ...current }));
        browser.close(1011, "synthesis unavailable");
      }
      upstream?.terminate();
    };
    let timer = setTimeout(() => fail("语音播报连接超时"), 15_000);
    const authorization = setInterval(() => {
      if (!pairing.active(principal)) browser.close(4003, "device authorization expired");
    }, 5_000);
    browser.on("error", () => browser.terminate());
    browser.on("close", () => {
      clearTimeout(timer);
      clearInterval(authorization);
      upstream?.terminate();
    });
    browser.on("message", (raw, binary) => {
      if (!pairing.active(principal)) { browser.close(4003, "device authorization expired"); return; }
      try {
        if (binary) throw new Error("语音播报参数必须是文字");
        const control = JSON.parse(raw.toString());
        if (!control || typeof control !== "object") throw new Error("语音播报参数无效");
        if (control.type === "cancel") {
          if (!current || control.sessionId !== current.sessionId || control.generation !== current.generation) throw new Error("语音播报会话无效");
          if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "cancel", ...current }));
          browser.close(1000, "cancelled");
          return;
        }
        if (current || control.type !== "start"
          || typeof control.sessionId !== "string" || !control.sessionId.trim() || control.sessionId.length > 128
          || !Number.isSafeInteger(control.generation) || control.generation < 0
          || typeof control.text !== "string" || !control.text.trim() || control.text.length > 600
          || (control.speed !== undefined && (typeof control.speed !== "number" || !Number.isFinite(control.speed) || control.speed < 0.5 || control.speed > 2))) {
          throw new Error("语音播报参数无效");
        }
        current = { sessionId: control.sessionId, generation: control.generation };
        const endpoint = new URL("/v1/tts/stream", serviceUrl);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        upstream = new WebSocket(endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, maxPayload: 256 * 1024 });
        upstream.on("open", () => upstream.send(JSON.stringify({ type: "start", ...current, text: control.text, speed: control.speed ?? 1 })));
        upstream.on("error", () => fail("语音播报服务不可用，请检查服务配置"));
        upstream.on("close", () => { if (browser.readyState === WebSocket.OPEN) fail("语音播报服务连接已断开"); });
        upstream.on("message", (data, isBinary) => {
          if (browser.readyState !== WebSocket.OPEN) return;
          if (!pairing.active(principal)) { browser.close(4003, "device authorization expired"); return; }
          if (browser.bufferedAmount > 256 * 1024) { fail("网络过慢，语音播报已停止"); return; }
          if (isBinary) {
            if (!started || data.length % 2 !== 0) { fail("语音播报音频无效"); return; }
            browser.send(data, { binary: true });
          } else {
            let event;
            try { event = JSON.parse(data.toString()); } catch { fail("语音播报服务返回无效数据"); return; }
            if (event.type === "error") { fail("语音合成失败，请检查服务凭据、网络或额度"); return; }
            if (event.sessionId !== current.sessionId || event.generation !== current.generation) return;
            if (event.type === "started") {
              if (started || event.sampleRate !== 24_000 || event.channels !== 1 || event.sampleFormat !== "s16le") { fail("语音播报格式不受支持"); return; }
              started = true;
            }
            if (!["started", "finished", "cancelled"].includes(event.type)) return;
            browser.send(JSON.stringify({ type: event.type, ...current, ...(event.type === "started" ? { sampleRate: 24_000, channels: 1, sampleFormat: "s16le" } : {}) }));
            if (event.type !== "started") { browser.close(1000, event.type); return; }
          }
          clearTimeout(timer);
          timer = setTimeout(() => fail("语音播报超时"), 30_000);
        });
      } catch { fail("语音播报请求无效"); }
    });
  });
  return {
    handleUpgrade(req, socket, head) {
      if (new URL(req.url, "http://gateway.local").pathname !== "/ws/voice/tts") return false;
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
