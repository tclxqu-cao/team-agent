import { describe, expect, it, vi } from "vitest";
import { prepareAgentRuntimeEnvironment, prepareCodexRuntimeEnvironment, prepareOpenCodeRuntimeEnvironment } from "./runtime-manager.js";

describe("prepareCodexRuntimeEnvironment", () => {
  it("injects the resolved absolute Codex executable", async () => {
    const report = vi.fn();
    const environment = await prepareCodexRuntimeEnvironment(
      { PATH: "/bin" },
      { dataDir: "/data", target: "windows-amd64" },
      async () => ({
        executable: "D:\\AgentRoam\\codex.exe",
        version: "0.153.0",
        source: "managed",
      }),
      report,
    );

    expect(environment.AGENT_CODEX_BIN).toBe("D:\\AgentRoam\\codex.exe");
    expect(environment.AGENT_CODEX_RUNTIME_ERROR).toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("managed"));
  });

  it("allows the resolver to install missing Codex with a cancellation deadline", async () => {
    const resolver = vi.fn(async () => { throw new Error("Codex not installed"); });
    const environment = await prepareCodexRuntimeEnvironment({}, { dataDir: "/data", target: "darwin-arm64" }, resolver, vi.fn());
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(resolver).toHaveBeenCalledWith(expect.not.objectContaining({ installIfMissing: false }));
    expect(environment.AGENT_CODEX_RUNTIME_ERROR).toBe("Codex not installed");
  });

  it("bounds an unresponsive Codex installer and records unavailable sessions", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const report = vi.fn();
      const pending = prepareCodexRuntimeEnvironment({}, { dataDir: "/data", target: "darwin-arm64" },
        async options => { signal = options.signal; return new Promise(() => {}); }, report);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      const environment = await pending;
      expect(signal?.aborted).toBe(true);
      expect(environment.AGENT_CODEX_BIN).toBeUndefined();
      expect(environment.AGENT_CODEX_RUNTIME_ERROR).toContain("180 秒");
      expect(report).toHaveBeenLastCalledWith(expect.stringContaining("会话功能未就绪"));
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("removes an unusable inherited override and keeps startup available", async () => {
    const report = vi.fn();
    const environment = await prepareCodexRuntimeEnvironment(
      { PATH: "/bin", AGENT_CODEX_BIN: "/missing/codex" },
      { dataDir: "/data", target: "darwin-arm64" },
      async () => { throw new Error("download failed"); },
      report,
    );

    expect(environment.AGENT_CODEX_BIN).toBeUndefined();
    expect(environment.AGENT_CODEX_RUNTIME_ERROR).toBe("download failed");
    expect(environment.PATH).toBe("/bin");
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("会话功能未就绪"));
  });
});

describe("prepareAgentRuntimeEnvironment", () => {
  it("checks agents concurrently within one preparation window and preserves ready Codex when OpenCode stalls", async () => {
    vi.useFakeTimers();
    try {
      const codex = vi.fn(async () => ({ executable: "/managed/codex", version: "1.0.0", source: "managed" as const }));
      const opencode = vi.fn(async () => new Promise<never>(() => {}));
      const pending = prepareAgentRuntimeEnvironment({ AGENT_CODEX_RUNTIME_ERROR: "old", AGENT_OPENCODE_BIN: "/old/opencode" },
        { dataDir: "/data", target: "darwin-arm64", timeoutMs: 60_000 }, codex, vi.fn(), opencode);
      await vi.advanceTimersByTimeAsync(0);
      expect(codex).toHaveBeenCalledOnce();
      expect(opencode).toHaveBeenCalledWith(expect.objectContaining({ installIfMissing: false }));
      await vi.advanceTimersByTimeAsync(60_000);
      const environment = await pending;
      expect(environment.AGENT_CODEX_BIN).toBe("/managed/codex");
      expect(environment.AGENT_CODEX_RUNTIME_ERROR).toBeUndefined();
      expect(environment.AGENT_OPENCODE_BIN).toBeUndefined();
      expect(environment.AGENT_OPENCODE_RUNTIME_ERROR).toContain("检查超时");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("prepareOpenCodeRuntimeEnvironment", () => {
  it("keeps startup offline instead of downloading missing OpenCode", async () => {
    const resolver = vi.fn(async () => { throw new Error("OpenCode not installed"); });
    const environment = await prepareOpenCodeRuntimeEnvironment({}, { dataDir: "/data", target: "darwin-arm64" }, resolver, vi.fn());
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ installIfMissing: false }));
    expect(environment.AGENT_OPENCODE_RUNTIME_ERROR).toBe("OpenCode not installed");
  });

  it("injects OpenCode independently from Codex", async () => {
    const environment = await prepareOpenCodeRuntimeEnvironment(
      { PATH: "/bin", AGENT_CODEX_BIN: "/managed/codex" },
      { dataDir: "/data", target: "darwin-arm64" },
      async () => ({ executable: "/managed/opencode", version: "1.18.27", source: "managed" }),
      vi.fn(),
    );
    expect(environment).toMatchObject({
      AGENT_CODEX_BIN: "/managed/codex",
      AGENT_OPENCODE_BIN: "/managed/opencode",
    });
  });

  it("records OpenCode failure without removing Codex", async () => {
    const environment = await prepareOpenCodeRuntimeEnvironment(
      { AGENT_CODEX_BIN: "/managed/codex", AGENT_OPENCODE_BIN: "/bad/opencode" },
      { dataDir: "/data", target: "darwin-arm64" },
      async () => { throw new Error("OpenCode download failed"); },
      vi.fn(),
    );
    expect(environment.AGENT_CODEX_BIN).toBe("/managed/codex");
    expect(environment.AGENT_OPENCODE_BIN).toBeUndefined();
    expect(environment.AGENT_OPENCODE_RUNTIME_ERROR).toBe("OpenCode download failed");
  });
});
