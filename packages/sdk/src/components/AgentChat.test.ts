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

  it("does not pass a privileged registration token through the browser component", () => {
    const registerRemoteTools = vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockResolvedValue();
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);

    const chat = new AgentChat() as TestableAgentChat & { registrationToken?: string };
    chat.server = "http://agent";
    chat.token = "sdk-token";
    chat.registrationToken = "registration-token";
    chat.projectId = "remote-tools-test-project";
    chat.remoteTools = [{ scheme: "create_remote_tool", purpose: "创建", url: "http://tools.example/api" }];

    chat._initClient();
    const client = chat.client as unknown as { registrationToken?: string };

    expect(registerRemoteTools).toHaveBeenCalledOnce();
    expect(client.registrationToken).toBeUndefined();
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

  it("creates sessions with the component project id", async () => {
    vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockResolvedValue();
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);
    const createSession = vi.spyOn(AgentClient.prototype, "createSession").mockResolvedValue({
      id: "session-1",
      title: "AI 助手",
      status: "idle",
      created: "now",
      updated: "now",
    });

    const chat = new AgentChat() as TestableAgentChat;
    chat.server = "http://agent";
    chat.token = "sdk-token";
    chat.title = "AI 助手";
    chat.projectId = "kid-earth-learning";

    chat._initClient();
    await (chat as unknown as { _ensureSession(): Promise<void> })._ensureSession();

    expect(createSession).toHaveBeenCalledWith("AI 助手", "kid-earth-learning");
  });

  it("lists sessions with the component project id", async () => {
    vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockResolvedValue();
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);
    const listSessions = vi.spyOn(AgentClient.prototype, "listSessions").mockResolvedValue([]);

    const chat = new AgentChat() as TestableAgentChat;
    chat.server = "http://agent";
    chat.token = "sdk-token";
    chat.projectId = "kid-earth-learning";

    chat._initClient();
    await (chat as unknown as { _loadSessions(): Promise<void> })._loadSessions();

    expect(listSessions).toHaveBeenCalledWith("kid-earth-learning");
  });

  it("does not emit an unhandled rejection when startup registration fails before user sends", async () => {
    vi.spyOn(AgentClient.prototype, "registerRemoteTools").mockRejectedValue(new Error("register failed"));
    vi.spyOn(AgentClient.prototype, "onEvent").mockReturnValue(() => undefined);

    const unhandled = vi.fn();
    const previousHandler = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", unhandled);

    try {
      const chat = new AgentChat() as TestableAgentChat;
      chat.server = "http://agent";
      chat.token = "sdk-token";
      chat.projectId = "remote-tools-test-project";
      chat.remoteTools = [{ scheme: "create_remote_tool", purpose: "创建", url: "http://tools.example/api" }];
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
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
      expect(chat._store.setError).not.toHaveBeenCalled();

      await chat._sendMessage();

      expect(chat._store.setError).toHaveBeenCalledOnce();
      expect(chat._store.setError).toHaveBeenCalledWith(expect.stringContaining("远端工具注册失败"));
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      for (const handler of previousHandler) process.on("unhandledRejection", handler);
    }
  });
});
