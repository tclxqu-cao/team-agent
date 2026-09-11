import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error MV3 JavaScript is shipped without Electron-specific types.
import { ChromeTabBridge, parsePairingCode, siteForUrl } from "../../chrome-extension/bridge-client.js";
const bridges: ChromeTabBridge[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) { bridge.ready = false; for (const site of [...bridge.tabs.keys()]) await bridge.detach(site); } vi.useRealTimers(); });
function setup(siteId = "chatgpt") {
  let url = siteId === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/";
  let acceptSubmit = true;
  let draft = "";
  const messages: Array<{ id: string; messageId?: string; role: string; content: string; plainText: string }> = [];
  const snapshot = () => ({ conversationId: "/", messages: messages.map((m) => ({ ...m })), userCount: messages.filter((m) => m.role === "user").length, generating: false, composerAvailable: true, draft });
  const api = {
    debugger: {
      onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() }, attach: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_target: unknown, method: string, params: Record<string, any> = {}): Promise<any> => {
        if (method === "Runtime.evaluate") {
          if (params.expression.startsWith("Boolean(")) return { result: { value: false } };
          if (params.expression.includes(')("chatgpt","prepare",') && draft === 'existing') return { exceptionDetails: { exception: { description: 'Error: chrome-existing-draft' } } };
          if (params.expression.includes('","submit-target",')) return { result: { value: { kind: "button", x: 100, y: 200 } } };
          return { result: { value: snapshot() } };
        }
        if (method === "Input.insertText") draft = params.text;
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && acceptSubmit) { messages.push({ id: `u${messages.length}`, role: "user", content: draft, plainText: draft }); draft = ""; }
        return {};
      }),
    },
    tabs: { get: vi.fn(async () => ({ id: 1, url })), onRemoved: { addListener: vi.fn() }, reload: vi.fn() },
    webNavigation: { onBeforeNavigate: { addListener: vi.fn() } },
  };
  const bridge = new ChromeTabBridge(api); bridges.push(bridge);
  const sent: any[] = [];
  bridge.socket = { readyState: 1, bufferedAmount: 0, send: (data: string) => sent.push(JSON.parse(data)) }; bridge.ready = true;
  return { bridge, api, sent, messages, navigate: (next: string) => { url = next; }, setAccept: (value: boolean) => { acceptSubmit = value; }, setDraft: (value: string) => { draft = value; } };
}

describe("Chrome native conversations", () => {
  it("keeps login and unrelated pages outside the bridge", () => {
    expect(parsePairingCode(`aihub:19473:${"a".repeat(64)}`).port).toBe(19473);
    expect(() => parsePairingCode("https://evil.test")).toThrow();
    expect(siteForUrl("https://accounts.google.com/signin")).toBeNull();
    expect(siteForUrl("https://grok.com/login")).toBeNull();
  });
  it("publishes successive text snapshots without screenshots or page timers", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent, messages } = setup();
    await bridge.attach(1);
    messages.push({ id: "a1", role: "assistant", content: "你好", plainText: "你好" });
    await vi.advanceTimersByTimeAsync(401);
    messages[0].content += "世界";
    await vi.advanceTimersByTimeAsync(401);
    const conversations = sent.filter((m) => m.type === "conversation");
    expect(conversations.at(-2).conversation.messages[0].content).toBe("你好");
    expect(conversations.at(-1).conversation.messages[0]).toEqual({ id: "a1", role: "assistant", content: "你好世界" });
    expect(conversations.at(-1).conversation.draft).toBeUndefined();
    expect(api.debugger.sendCommand.mock.calls.some(([, method]) => method.includes("Screenshot") || method.includes("Screencast") || method.includes("MetricsOverride"))).toBe(false);
  });
  it("sends trusted browser input exactly once and confirms a new user message", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent } = setup(); await bridge.attach(1);
    const run = bridge.handleCommand({ id: 1, siteId: "chatgpt", command: "send-message", payload: { text: "你好" } });
    await vi.advanceTimersByTimeAsync(2500); await run;
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.insertText", { text: "你好" });
    expect(api.debugger.sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")).toHaveLength(1);
    expect(sent).toContainEqual({ type: "reply", id: 1, ok: true, result: { submitted: true } });
  });
  it("keeps provider tabs active in the background and restores focus emulation on detach", async () => {
    const { bridge, api } = setup(); await bridge.attach(1);
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await bridge.detach("chatgpt");
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Emulation.setFocusEmulationEnabled", { enabled: false });
  });
  it("confirms two consecutive sends without resending the first message", async () => {
    vi.useFakeTimers();
    const { bridge, messages, sent } = setup(); await bridge.attach(1);
    for (const [id, text] of [[1, "第一条"], [2, "第二条"]] as const) {
      const run = bridge.handleCommand({ id, siteId: "chatgpt", command: "send-message", payload: { text } });
      await vi.advanceTimersByTimeAsync(2500); await run;
      expect(sent).toContainEqual({ type: "reply", id, ok: true, result: { submitted: true } });
    }
    expect(messages.map((m) => m.plainText)).toEqual(["第一条", "第二条"]);
  });
  it("does not report success or resubmit when a website ignores the submit", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent, setAccept } = setup(); await bridge.attach(1); setAccept(false);
    const run = bridge.handleCommand({ id: 2, siteId: "chatgpt", command: "send-message", payload: { text: "hi" } });
    await vi.advanceTimersByTimeAsync(26000); await run;
    expect(sent).toContainEqual({ type: "reply", id: 2, ok: false, error: "chrome-submit-unconfirmed" });
    expect(api.debugger.sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")).toHaveLength(1);
  });
  it("confirms a new stable message when ChatGPT removes older DOM turns and the user count decreases", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent, messages } = setup(); await bridge.attach(1);
    for (let i = 0; i < 3; i++) messages.push({ id: `${i}:old-${i}`, messageId: `old-${i}`, role: "user", content: "earlier", plainText: "earlier" });
    const normal = api.debugger.sendCommand.getMockImplementation()!;
    api.debugger.sendCommand.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (args[1] === "Input.dispatchMouseEvent" && args[2]?.type === "mouseReleased") {
        const latest = messages.at(-1)!;
        messages.splice(0, messages.length, { ...latest, id: "0:new-message", messageId: "new-message" });
      }
      return result;
    });
    const run = bridge.handleCommand({ id: 7, siteId: "chatgpt", command: "send-message", payload: { text: "收到了" } });
    await vi.advanceTimersByTimeAsync(2500); await run;
    expect(messages).toHaveLength(1);
    expect(sent).toContainEqual({ type: "reply", id: 7, ok: true, result: { submitted: true } });
    expect(api.debugger.sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")).toHaveLength(1);
  });
  it("does not mistake a previous identical message for a new send when history loads and its display index changes", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent, messages, setAccept, setDraft } = setup(); await bridge.attach(1); setAccept(false);
    messages.push({ id: "0:previous", messageId: "previous", role: "user", content: "收到了", plainText: "收到了" });
    const normal = api.debugger.sendCommand.getMockImplementation()!;
    api.debugger.sendCommand.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (args[1] === "Input.dispatchMouseEvent" && args[2]?.type === "mouseReleased") {
        messages[0].id = "1:previous";
        messages.unshift({ id: "0:older", messageId: "older", role: "user", content: "older", plainText: "older" });
        setDraft("");
      }
      return result;
    });
    const run = bridge.handleCommand({ id: 8, siteId: "chatgpt", command: "send-message", payload: { text: "收到了" } });
    await vi.advanceTimersByTimeAsync(26000); await run;
    expect(sent).toContainEqual({ type: "reply", id: 8, ok: false, error: "chrome-submit-unconfirmed" });
  });
  it("confirms a delayed website receipt after the former ten-second window without resending", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent, messages, setAccept, setDraft } = setup(); await bridge.attach(1); setAccept(false);
    const run = bridge.handleCommand({ id: 9, siteId: "chatgpt", command: "send-message", payload: { text: "delayed" } });
    await vi.advanceTimersByTimeAsync(12000);
    expect(sent.some(message => message.type === "reply")).toBe(false);
    messages.push({ id: "new", messageId: "new", role: "user", content: "delayed", plainText: "delayed" }); setDraft("");
    await vi.advanceTimersByTimeAsync(2000); await run;
    expect(sent).toContainEqual({ type: "reply", id: 9, ok: true, result: { submitted: true } });
    expect(api.debugger.sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")).toHaveLength(1);
  });
  it("does not acknowledge an optimistic message that the website rolls back", async () => {
    vi.useFakeTimers();
    const { bridge, api, sent, messages, setDraft } = setup(); await bridge.attach(1);
    const normal = api.debugger.sendCommand.getMockImplementation()!;
    let rejected = false;
    api.debugger.sendCommand.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (rejected && args[1] === "Runtime.evaluate" && result.result?.value?.messages) result.result.value.websiteError = "chrome-gemini-error-1097";
      return result;
    });
    const run = bridge.handleCommand({ id: 5, siteId: "chatgpt", command: "send-message", payload: { text: "test rollback" } });
    await vi.advanceTimersByTimeAsync(750);
    expect(sent.some((m) => m.type === "reply")).toBe(false);
    messages.length = 0; setDraft("test rollback"); rejected = true;
    await vi.advanceTimersByTimeAsync(1000); await run;
    expect(sent).toContainEqual({ type: "reply", id: 5, ok: false, error: "chrome-gemini-error-1097" });
    expect(api.debugger.sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")).toHaveLength(1);
  });
  it("waits for a Gemini reply instead of acknowledging its optimistic user bubble", async () => {
    vi.useFakeTimers();
    const { bridge, sent, messages } = setup("gemini"); await bridge.attach(1);
    const run = bridge.handleCommand({ id: 6, siteId: "gemini", command: "send-message", payload: { text: "wait for reply" } });
    await vi.advanceTimersByTimeAsync(2500);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(sent.some((m) => m.type === "reply")).toBe(false);
    messages.push({ id: "reply", role: "assistant", content: "accepted", plainText: "accepted" });
    await vi.advanceTimersByTimeAsync(2000); await run;
    expect(sent).toContainEqual({ type: "reply", id: 6, ok: true, result: { submitted: true } });
  });
  it("preserves existing drafts and never sends input to authentication pages", async () => {
    const { bridge, api, sent, setDraft, navigate } = setup(); await bridge.attach(1); setDraft("existing");
    await bridge.handleCommand({ id: 3, siteId: "chatgpt", command: "send-message", payload: { text: "hi" } });
    expect(sent).toContainEqual({ type: "reply", id: 3, ok: false, error: "chrome-existing-draft" });
    navigate("https://accounts.google.com/");
    await bridge.handleCommand({ id: 4, siteId: "chatgpt", command: "send-message", payload: { text: "hi" } });
    expect(api.debugger.sendCommand.mock.calls.some(([, method]) => method === "Input.insertText")).toBe(false);
    expect(bridge.tabs.size).toBe(0);
  });
  it("ignores late read results after detach", async () => {
    const { bridge, api, sent } = setup(); await bridge.attach(1); sent.length = 0;
    let release!: (value: any) => void;
    const normal = api.debugger.sendCommand.getMockImplementation()!;
    api.debugger.sendCommand.mockImplementation(async (...args) => args[1] === "Runtime.evaluate" && args[2]?.expression.includes(')("chatgpt","snapshot",') ? new Promise((resolve) => { release = resolve; }) : normal(...args));
    const read = bridge.pollConversation("chatgpt");
    await vi.waitFor(() => expect(release).toBeDefined());
    await bridge.detach("chatgpt"); release({ result: { value: { messages: [] } } }); await read;
    expect(sent.some((m) => m.type === "conversation")).toBe(false);
  });
});
