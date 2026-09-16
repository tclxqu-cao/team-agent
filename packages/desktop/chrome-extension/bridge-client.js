import { pageAction } from "./page-actions.js";
const ORIGINS = { chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com", grok: "https://grok.com" };
export function siteForUrl(value) {
  try {
    const url = new URL(value);
    if (/^\/(auth|login|signin|sign-in|signup|sign-up)(\/|$)/i.test(url.pathname)) return null;
    return Object.keys(ORIGINS).find((id) => ORIGINS[id] === url.origin) ?? null;
  } catch { return null; }
}
export function parsePairingCode(value) {
  const match = /^aihub:(\d{1,5}):([a-f0-9]{64})$/.exec(value.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error("请粘贴 AI Hub 中复制的连接码");
  return { port: Number(match[1]), token: match[2] };
}

/** No account cookies, credential APIs or login-page script injection. */
export class ChromeTabBridge {
  constructor(api, socketFactory = (url) => new WebSocket(url)) {
    this.api = api; this.socketFactory = socketFactory;
    this.socket = null; this.ready = false; this.tabs = new Map(); this.epoch = 0;
    this.heartbeat = null; this.retry = null; this.pairing = null;
    this.queues = new Map();
    api.debugger.onEvent.addListener((source, method, params) => { void this.onDebugEvent(source, method, params).catch(() => {}); });
    api.debugger.onDetach.addListener((source, reason) => {
      const entry = [...this.tabs].find(([, tab]) => tab.id === source.tabId);
      if (entry && reason === "canceled_by_user") this.onUserDetach?.();
      if (entry) { clearTimeout(entry[1].pollTimer); this.tabs.delete(entry[0]); this.send({ type: "detached", siteId: entry[0] }); }
    });
    api.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
      if (frameId !== 0) return;
      const entry = [...this.tabs].find(([, tab]) => tab.id === tabId);
      if (entry && siteForUrl(url) !== entry[0]) void this.detach(entry[0]);
    });
    api.tabs.onRemoved.addListener((tabId) => {
      const entry = [...this.tabs].find(([, tab]) => tab.id === tabId);
      if (entry) void this.detach(entry[0]);
    });
  }

  async sendCommand(target, method, params) {
    let timer;
    try {
      return await Promise.race([
        params === undefined ? this.api.debugger.sendCommand(target, method) : this.api.debugger.sendCommand(target, method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("chrome-command-timeout")), 4000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  send(message) {
    if (this.ready && this.socket?.readyState === 1 && this.socket.bufferedAmount < 8_000_000) this.socket.send(JSON.stringify(message));
  }
  status() { return { connected: this.ready, sites: [...this.tabs.keys()] }; }

  async connect(pairing) {
    if (this.ready && this.pairing?.port === pairing.port && this.pairing?.token === pairing.token) return this.status();
    this.pairing = pairing;
    const epoch = ++this.epoch;
    clearTimeout(this.retry);
    const previous = this.socket;
    this.socket = null; this.ready = false;
    previous?.close();
    clearInterval(this.heartbeat);
    const socket = this.socketFactory(`ws://127.0.0.1:${pairing.port}`);
    this.socket = socket;
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("无法连接 AI Hub，请确认桌面端已经启动")); socket.close(); }, 5000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: pairing.token, version: "0.3.5", capabilities: ["conversations-v1", "auto-connect-control-v1"] }));
      socket.onerror = () => { clearTimeout(timer); reject(new Error("无法连接 AI Hub，请确认桌面端已启动")); };
      socket.onmessage = ({ data }) => {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message.type === "ready") {
          clearTimeout(timer); this.ready = true;
          this.heartbeat = setInterval(() => this.send({ type: "ping" }), 20_000);
          for (const [siteId, tab] of this.tabs) this.send({ type: "tab", siteId, tabId: tab.id, url: ORIGINS[siteId] });
          resolve(this.status());
          this.onReady?.();
        } else if (message.type === "command" && this.ready) {
          // 同一标签页的输入与广播严格串行，避免鼠标 down/up 或上传/发送乱序。
          const queue = this.queues.get(message.siteId) ?? Promise.resolve();
          const next = queue.catch(() => {}).then(() => { if (epoch === this.epoch && this.ready) return this.handleCommand(message); });
          this.queues.set(message.siteId, next);
          void next.finally(() => { if (this.queues.get(message.siteId) === next) this.queues.delete(message.siteId); });
        }
      };
      socket.onclose = () => {
        clearTimeout(timer);
        reject(new Error("Chrome 与 AI Hub 的连接已断开"));
        if (this.socket !== socket) return;
        this.ready = false; clearInterval(this.heartbeat);
        // 断开控制后释放调试；自动连接控制器在恢复后重新发现标签页。
        for (const site of [...this.tabs.keys()]) void this.detach(site);
        this.retry = setTimeout(() => { if (this.pairing) void this.connect(this.pairing).catch(() => {}); }, 3000);
      };
    });
    return connected;
  }

  async disconnect() {
    this.pairing = null; ++this.epoch;
    clearTimeout(this.retry); clearInterval(this.heartbeat);
    for (const site of [...this.tabs.keys()]) await this.detach(site);
    const socket = this.socket; this.socket = null; this.ready = false;
    socket?.close();
  }

  async assertProviderPage(siteId, tabId) {
    if (siteForUrl((await this.api.tabs.get(tabId)).url) !== siteId) throw new Error("chrome-auth-required");
    // 仅检查表单是否存在，不读取字段值；站点内弹出的密码/验证码表单也退出控制。
    const auth = await this.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `Boolean(document.querySelector('input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"]'))`,
      returnByValue: true,
    });
    if (auth.exceptionDetails || typeof auth.result?.value !== "boolean") throw new Error("chrome-page-loading");
    if (auth.result.value) throw new Error("chrome-auth-required");
  }

  async attach(tabId) {
    if (!this.ready) throw new Error("请先连接本机 AI Hub");
    const current = await this.api.tabs.get(tabId);
    const siteId = siteForUrl(current.url);
    if (!siteId) throw new Error("请先在 Chrome 完成登录，再从 ChatGPT、Gemini 或 Grok 页面连接");
    if (this.tabs.has(siteId)) await this.detach(siteId);
    const epoch = this.epoch;
    const target = { tabId };
    await this.api.debugger.attach(target, "1.3");
    if (!this.ready || epoch !== this.epoch) {
      await this.api.debugger.detach(target).catch(() => {});
      throw new Error("chrome-tab-disconnected");
    }
    this.tabs.set(siteId, { id: tabId, pollTimer: null, polling: false, failures: 0, revision: 0 });
    try {
      // 再检查一次，避免 attach 期间已经跳往认证页面。
      await this.assertProviderPage(siteId, tabId);
      await this.sendCommand(target, "Page.enable");
      // Keep native background tabs rendering without changing the user's selected tab.
      await this.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true });
      this.send({ type: "tab", siteId, tabId, url: ORIGINS[siteId] });
      await this.pollConversation(siteId);
      if (!this.tabs.has(siteId)) throw new Error("chrome-page-operation-failed");
      return { siteId };
    } catch (error) { await this.detach(siteId); throw error; }
  }

  async detach(siteId) {
    const tab = this.tabs.get(siteId);
    if (!tab) return;
    clearTimeout(tab.pollTimer);
    this.tabs.delete(siteId);
    this.send({ type: "detached", siteId });
    await this.sendCommand({ tabId: tab.id }, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    await this.sendCommand({ tabId: tab.id }, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await this.api.debugger.detach({ tabId: tab.id }).catch(() => {});
  }

  async onDebugEvent(source, method, params) {
    const entry = [...this.tabs].find(([, tab]) => tab.id === source.tabId);
    if (!entry) return;
    const [siteId] = entry;
    if (method === "Page.frameNavigated" && !params.frame?.parentId && siteForUrl(params.frame?.url) !== siteId) {
      await this.detach(siteId); return;
    }
  }

  async readPage(siteId, action = "snapshot", payload = {}) {
    const tab = this.tabs.get(siteId);
    if (!tab) throw new Error("chrome-tab-disconnected");
    await this.assertProviderPage(siteId, tab.id);
    const response = await this.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
      expression: `(${pageAction.toString()})(${JSON.stringify(siteId)},${JSON.stringify(action)},${JSON.stringify(payload)})`,
      returnByValue: true, userGesture: action !== "snapshot",
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "";
      throw new Error(/chrome-[a-z-]+/.exec(description)?.[0] ?? "chrome-page-loading");
    }
    if (this.tabs.get(siteId) !== tab) throw new Error("chrome-tab-disconnected");
    return response.result?.value;
  }

  publishConversation(siteId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.messages)) throw new Error("chrome-page-loading");
    const tab = this.tabs.get(siteId);
    if (!tab) return;
    // Draft and plain-text matching fields remain inside the extension.
    this.send({ type: "conversation", siteId, conversation: {
      conversationId: snapshot.conversationId, revision: ++tab.revision,
      messages: snapshot.messages.map(({ id, role, content }) => ({ id, role, content })),
      generating: snapshot.generating, composerAvailable: snapshot.composerAvailable,
    } });
  }

  async pollConversation(siteId) {
    const tab = this.tabs.get(siteId);
    if (!tab || tab.polling || !this.ready) return;
    clearTimeout(tab.pollTimer); tab.polling = true;
    try {
      const snapshot = await this.readPage(siteId);
      if (this.tabs.get(siteId) !== tab) return;
      this.publishConversation(siteId, snapshot); tab.failures = 0;
    } catch (error) {
      if (error.message === "chrome-auth-required") await this.detach(siteId);
      else if (this.tabs.get(siteId) === tab && ++tab.failures >= 3) this.send({ type: "page-error", siteId, error: "chrome-conversation-unavailable" });
    } finally {
      tab.polling = false;
      if (this.tabs.get(siteId) === tab && this.ready) tab.pollTimer = setTimeout(() => { void this.pollConversation(siteId); }, 400);
    }
  }

  async sendMessage(siteId, text, images = []) {
    if (typeof text !== "string" || text.length > 100_000 || (!text.trim() && !images.length)) throw new Error("chrome-invalid-message");
    const tab = this.tabs.get(siteId);
    if (!tab) throw new Error("chrome-tab-disconnected");
    const target = { tabId: tab.id };
    await this.assertProviderPage(siteId, tab.id);
    await this.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true });
    const before = await this.readPage(siteId, "prepare", { text });
    const previousUserIds = new Set(before.messages.filter(message => message.role === "user").map(message => message.messageId).filter(Boolean));
    tab.sendConfirmation = undefined;
    const assertCurrent = async () => {
      if (this.tabs.get(siteId) !== tab || !this.ready) throw new Error("chrome-tab-disconnected");
      await this.assertProviderPage(siteId, tab.id);
    };
    if (images.length) {
      if (images.length > 4 || images.some((data) => typeof data !== "string" || data.length > 4_500_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data))) throw new Error("chrome-invalid-image");
      const response = await this.sendCommand(target, "Runtime.evaluate", { expression: `(async () => {
        (${pageAction.toString()})(${JSON.stringify(siteId)}, 'prepare', {text:${JSON.stringify(text)}});
        const input = [...document.querySelectorAll('input[type="file"]')].find(el => !el.disabled && (!el.accept || /image|png|jpeg|webp/.test(el.accept)));
        if (!input) throw new Error('chrome-upload-unavailable');
        const transfer = new DataTransfer();
        for (const [index, data] of ${JSON.stringify(images)}.entries()) { const blob = await (await fetch(data)).blob(); transfer.items.add(new File([blob], 'aihub-' + index + '.' + blob.type.split('/')[1], {type:blob.type})); }
        input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); return true;
      })()`, awaitPromise: true, returnByValue: true, userGesture: true });
      if (response.exceptionDetails) throw new Error("chrome-upload-unavailable");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await this.readPage(siteId, 'prepare', { text });
    }
    await assertCurrent();
    if (text) await this.sendCommand(target, "Input.insertText", { text });
    let submit;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      submit = await this.readPage(siteId, "submit-target", { text });
      if (submit.kind !== "disabled") break;
    }
    if (submit.kind === "disabled") throw new Error("chrome-send-disabled");
    const current = await this.readPage(siteId);
    if (current.conversationId !== before.conversationId) throw new Error("chrome-conversation-changed");
    await assertCurrent();
    // Browser input, not synthetic DOM KeyboardEvents. Submit exactly once.
    if (submit.kind === "button") {
      await this.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: submit.x, y: submit.y });
      for (const type of ["mousePressed", "mouseReleased"]) await this.sendCommand(target, "Input.dispatchMouseEvent", { type, x: submit.x, y: submit.y, button: "left", clickCount: 1 });
    } else {
      await this.readPage(siteId, "focus", { text });
      for (const type of ["keyDown", "keyUp"]) await this.sendCommand(target, "Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
    }
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    let acceptedAt = null;
    const confirmationDeadline = Date.now() + 24_000;
    while (Date.now() < confirmationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = await this.readPage(siteId);
      this.publishConversation(siteId, after);
      const lastUser = after.messages.filter((message) => message.role === "user").at(-1);
      if (/^chrome-gemini-error-\d{1,6}$/.test(after.websiteError ?? '') && after.draft?.trim() && !after.generating) throw new Error(after.websiteError);
      const responseStarted = siteId !== "gemini" || (after.messages.at(-1)?.role === "assistant" && !!after.messages.at(-1)?.content.trim());
      // Prefer the provider's identity: removing old DOM turns can keep/decrease the count.
      // Never use the display ID here, since its index changes when history is virtualized.
      const newUser = lastUser?.messageId && (previousUserIds.size || before.userCount === 0)
        ? !previousUserIds.has(lastUser.messageId) : after.userCount > before.userCount;
      tab.sendConfirmation = { beforeUserCount: before.userCount, afterUserCount: after.userCount, draftEmpty: !after.draft?.trim(), textMatches: normalize(lastUser?.plainText) === normalize(text), newUser: !!newUser, stableMessageId: !!lastUser?.messageId, responseStarted, lastRole: after.messages.at(-1)?.role };
      const accepted = responseStarted && newUser && !after.draft?.trim()
        && (!text.trim() || normalize(lastUser?.plainText) === normalize(text));
      if (!accepted) acceptedAt = null;
      else if (acceptedAt === null) acceptedAt = Date.now();
      // An optimistic user bubble can be rolled back when the server rejects it.
      // Require the cleared draft and new turn to persist across several snapshots.
      else if (Date.now() - acceptedAt >= 1500) return { submitted: true };
    }
    throw new Error("chrome-submit-unconfirmed");
  }

  async handleCommand(message) {
    const { id, siteId, command, payload = {} } = message;
    const epoch = this.epoch;
    try {
      let result;
      if (command === "resume-auto-connect" && this.onResume) result = await this.onResume();
      else if (command === "send-message") result = await this.sendMessage(siteId, payload.text, payload.images ?? []);
      else if (command === "continue") result = await this.readPage(siteId, "continue");
      else if (command === "snapshot") { result = await this.readPage(siteId); result.debug = { ...result.debug, sendConfirmation: this.tabs.get(siteId)?.sendConfirmation }; this.publishConversation(siteId, result); }
      else if (command === "detach") await this.detach(siteId);
      else if (command === "reload") { const tab = this.tabs.get(siteId); if (!tab) throw new Error("chrome-tab-disconnected"); await this.api.tabs.reload(tab.id); }
      else throw new Error("chrome-command-unsupported");
      if (epoch === this.epoch) this.send({ type: "reply", id, ok: true, result });
    } catch (error) {
      if (error.message === "chrome-auth-required") await this.detach(siteId);
      const reason = /^(?:chrome-[a-z-]+|chrome-gemini-error-\d{1,6})$/.test(error.message) ? error.message : "chrome-page-operation-failed";
      if (epoch === this.epoch) this.send({ type: "reply", id, ok: false, error: reason });
    }
  }
}
