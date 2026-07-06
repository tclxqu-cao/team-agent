import { describe, expect, it, vi } from "vitest";
import { AgentChat } from "./AgentChat";
import { AgentClient } from "../client/AgentClient";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type TestableAgentChat = AgentChat & {
  client: AgentClient | null;
  currentSessionId: string;
  _initClient(): void;
  _sendMessage(): Promise<void>;
  renderRoot: Pick<ParentNode, "querySelector">;
  _store: {
    isRunning: boolean;
    subscribe: (listener: () => void) => () => void;
    setRunning: (running: boolean) => void;
    clearError: () => void;
    setError: (error: string | null) => void;
    addMessage: (message: unknown) => void;
    getPendingAskUser: () => null;
  };
};

describe("AgentChat remote tool initialization", () => {
  it("parses project id and remote tools during init registration", () => {
    const registerRemoteTools = vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockResolvedValue();
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);

    const chat = new AgentChat() as TestableAgentChat;
    chat.server = "http://agent";
    chat.token = "sdk-token";
    chat.projectId = "kid-earth-learning";
    chat.remoteTools = JSON.stringify([
      {
        scheme: "create_kid_earth_course",
        purpose: "创建课程",
        url: "http://kid/api/agent-actions/create-course",
      },
    ]);

    chat._initClient();

    expect(registerRemoteTools).toHaveBeenCalledWith("kid-earth-learning", [
      {
        scheme: "create_kid_earth_course",
        purpose: "创建课程",
        url: "http://kid/api/agent-actions/create-course",
      },
    ]);
  });

  it("waits for startup registration before running the first user message", async () => {
    const registration = deferred<void>();
    const registerRemoteTools = vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockReturnValue(registration.promise);
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);
    const run = vi.spyOn(AgentClient.prototype, "run").mockResolvedValue();

    const chat = new AgentChat() as TestableAgentChat;
    chat.server = "http://agent";
    chat.token = "sdk-token";
    chat.projectId = "kid-earth-learning";
    chat.remoteTools = [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api" }];
    chat.currentSessionId = "session-1";
    chat.renderRoot = {
      querySelector: () => ({ value: "生成课程", style: { height: "auto" } }) as HTMLTextAreaElement,
    };
    chat._store = {
      isRunning: false,
      subscribe: vi.fn(() => () => undefined),
      setRunning: vi.fn((running: boolean) => { chat._store.isRunning = running; }),
      clearError: vi.fn(),
      setError: vi.fn(),
      addMessage: vi.fn(),
      getPendingAskUser: () => null,
    };

    chat._initClient();
    const sendPromise = chat._sendMessage();
    await Promise.resolve();

    expect(registerRemoteTools).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();

    registration.resolve();
    await sendPromise;

    expect(run).toHaveBeenCalledWith("生成课程", "session-1");
  });

  it("surfaces startup registration failures and does not run silently", async () => {
    vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockRejectedValue(new Error("register failed"));
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);
    const run = vi.spyOn(AgentClient.prototype, "run").mockResolvedValue();

    const chat = new AgentChat() as TestableAgentChat;
    chat.server = "http://agent";
    chat.token = "sdk-token";
    chat.projectId = "kid-earth-learning";
    chat.remoteTools = [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api" }];
    chat.currentSessionId = "session-1";
    chat.renderRoot = {
      querySelector: () => ({ value: "生成课程", style: { height: "auto" } }) as HTMLTextAreaElement,
    };
    chat._store = {
      isRunning: false,
      subscribe: vi.fn(() => () => undefined),
      setRunning: vi.fn((running: boolean) => { chat._store.isRunning = running; }),
      clearError: vi.fn(),
      setError: vi.fn(),
      addMessage: vi.fn(),
      getPendingAskUser: () => null,
    };

    chat._initClient();
    await chat._sendMessage();

    expect(run).not.toHaveBeenCalled();
    expect(chat._store.setError).toHaveBeenCalledWith(expect.stringContaining("远端工具注册失败"));
    expect(chat._store.setRunning).toHaveBeenLastCalledWith(false);
  });
});
