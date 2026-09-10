import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ChromeHubBridge } from "./chrome-bridge";
import { chromeHubSiteForUrl, validChromeHubInput, validChromeConversation } from "./chrome-bridge-protocol";
import { openExistingChrome } from "./existing-chrome";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hub-chrome-bridge-"));
  const bridge = new ChromeHubBridge(join(root, "state.json"));
  await bridge.start(0);
  const [, port, token] = bridge.pairingCode().split(":");
  cleanup.push(() => { bridge.close(); rmSync(root, { recursive: true, force: true }); });
  const connect = async (origin = `chrome-extension://${"a".repeat(32)}`, secret = token, capabilities = ["conversations-v1"]) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    socket.on("error", () => {});
    cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "hello", token: secret, capabilities }));
    return socket;
  };
  return { bridge, connect };
}

describe("existing Chrome bridge", () => {
  it("resumes a paused authenticated extension with no attached tabs, without bypassing tab command checks", async () => {
    const { bridge, connect } = await setup();
    await expect(bridge.resume()).rejects.toThrow("扩展未连接");
    const socket = await connect(undefined, undefined, ["conversations-v1", "auto-connect-control-v1"]);
    await vi.waitFor(() => expect(bridge.status().connected).toBe(true));
    socket.send(JSON.stringify({ type: "auto-connect-status", paused: true }));
    await vi.waitFor(() => expect(bridge.status().paused).toBe(true));
    await expect(bridge.request("chatgpt", "send-message", { text: "hi" })).rejects.toThrow();
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "command") return;
      expect(message.command).toBe("resume-auto-connect");
      socket.send(JSON.stringify({ type: "auto-connect-status", paused: false }));
      socket.send(JSON.stringify({ type: "reply", id: message.id, ok: true }));
    });
    await expect(bridge.resume()).resolves.toMatchObject({ connected: true, paused: false, tabs: [] });
    await expect(bridge.request("chatgpt", "send-message", { text: "hi" })).rejects.toThrow();
  });

  it("does not send resume to an extension without the control capability", async () => {
    const { bridge, connect } = await setup();
    const socket = await connect();
    await vi.waitFor(() => expect(bridge.status().connected).toBe(true));
    socket.send(JSON.stringify({ type: "auto-connect-status", paused: true }));
    await expect(bridge.resume()).rejects.toThrow("刷新");
    expect(bridge.status().paused).toBe(false);
  });

  it("identifies an old extension and refuses new commands until it is updated", async () => {
    const { bridge, connect } = await setup();
    const socket = await connect(undefined, undefined, []);
    await vi.waitFor(() => expect(bridge.status().connected).toBe(true));
    socket.send(JSON.stringify({ type: "tab", siteId: "chatgpt", tabId: 1, url: "https://chatgpt.com" }));
    await vi.waitFor(() => expect(bridge.status().tabs).toHaveLength(1));
    expect(bridge.status().compatible).toBe(false);
    await expect(bridge.request("chatgpt", "send-message", {text:"hi"})).rejects.toThrow("0.3.0");
  });

  it("rejects web origins and invalid pairing secrets", async () => {
    const { bridge, connect } = await setup();
    const web = await connect("https://evil.test");
    const extension = await connect(undefined, "invalid");
    await vi.waitFor(() => { expect(web.readyState).toBe(WebSocket.CLOSED); expect(extension.readyState).toBe(WebSocket.CLOSED); });
    expect(bridge.status()).toEqual({ connected: false, tabs: [], compatible: false, paused: false });
  });

  it("requires an authenticated, origin-matched tab before forwarding commands or frames", async () => {
    const { bridge, connect } = await setup();
    const socket = await connect();
    await vi.waitFor(() => expect(bridge.status().connected).toBe(true));
    socket.send(JSON.stringify({ type: "tab", siteId: "chatgpt", tabId: 1, url: "https://accounts.google.com/" }));
    await expect(bridge.request("chatgpt", "evaluate")).rejects.toThrow("连接");
    socket.send(JSON.stringify({ type: "tab", siteId: "chatgpt", tabId: 1, url: "https://chatgpt.com/c/private-id" }));
    await vi.waitFor(() => expect(bridge.status().tabs).toHaveLength(1));
    expect(bridge.status().tabs[0].url).toBe("https://chatgpt.com");
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "command") socket.send(JSON.stringify({ type: "reply", id: message.id, ok: true, result: "done" }));
    });
    await expect(bridge.request("chatgpt", "evaluate", { script: "1" })).resolves.toBe("done");
    socket.send(JSON.stringify({ type: "conversation", siteId: "chatgpt", conversation: { conversationId: "/c/1", revision: 1, messages: [{id:"1",role:"assistant",content:"hello"}], generating: true, composerAvailable: true } }));
    await vi.waitFor(() => expect(bridge.conversation("chatgpt")?.messages[0].content).toBe("hello"));
    socket.send(JSON.stringify({ type: "detached", siteId: "chatgpt" }));
    await vi.waitFor(() => expect(bridge.conversation("chatgpt")).toBeNull());
  });

  it("rejects outstanding requests and clears frames when the extension disconnects", async () => {
    const { bridge, connect } = await setup();
    const socket = await connect();
    await vi.waitFor(() => expect(bridge.status().connected).toBe(true));
    socket.send(JSON.stringify({ type: "tab", siteId: "grok", tabId: 3, url: "https://grok.com/" }));
    await vi.waitFor(() => expect(bridge.status().tabs).toHaveLength(1));
    const request = bridge.request("grok", "input");
    const assertion = expect(request).rejects.toThrow("断开");
    socket.close();
    await assertion;
    expect(bridge.status()).toEqual({ connected: false, tabs: [], compatible: false, paused: false });
  });

  it("opens ordinary Chrome without profile or remote-debugging flags", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await openExistingChrome("https://chatgpt.com/", run as never);
    expect(run).toHaveBeenCalledWith("/usr/bin/open", ["-a", "Google Chrome", "https://chatgpt.com/"]);
    await expect(openExistingChrome("javascript:alert(1)", run as never)).rejects.toThrow();
  });
});

describe("Chrome tab and input boundaries", () => {
  it("never maps authentication paths or unrelated origins", () => {
    expect(chromeHubSiteForUrl("https://chatgpt.com/c/123")).toBe("chatgpt");
    for (const url of ["https://accounts.google.com", "https://auth.openai.com", "https://chatgpt.com/auth/login", "https://chatgpt.com.evil.test", "http://grok.com", "chrome://settings"]) expect(chromeHubSiteForUrl(url)).toBeNull();
  });
  it("accepts bounded input and rejects arbitrary protocol objects", () => {
    expect(validChromeHubInput({ kind: "text", text: "你好" })).toBe(true);
    expect(validChromeHubInput({ kind: "pointer", action: "down", x: 0.5, y: 1 })).toBe(true);
    expect(validChromeHubInput({ kind: "pointer", action: "down", x: Infinity, y: 1 })).toBe(false);
    expect(validChromeHubInput({ kind: "key", action: "down", key: "Enter", code: "Enter", modifiers: 0 })).toBe(true);
    expect(validChromeHubInput({ kind: "Runtime.evaluate", expression: "alert(1)" })).toBe(false);
  });
});

describe("native conversation payload bounds", () => {
  const valid = { conversationId:"/c/1",revision:1,messages:[{id:"a",role:"assistant",content:"hello"}],generating:true,composerAvailable:true };
  it("accepts text and rejects duplicate IDs, overlong messages and invalid roles", () => {
    expect(validChromeConversation(valid)).toBe(true);
    expect(validChromeConversation({...valid,messages:[valid.messages[0],valid.messages[0]]})).toBe(false);
    expect(validChromeConversation({...valid,messages:[{id:"a",role:"system",content:"hi"}]})).toBe(false);
    expect(validChromeConversation({...valid,messages:[{id:"a",role:"assistant",content:"x".repeat(50001)}]})).toBe(false);
  });
});
