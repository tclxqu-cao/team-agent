import { beforeEach, describe, expect, it, vi } from "vitest";

const execution = vi.hoisted(() => ({ version: "1.18.30", serveError: false }));
vi.mock("node:child_process", () => {
  const execFile = vi.fn(async (_file, args) => {
    if (args[0] === "serve" && execution.serveError) throw new Error("serve unavailable");
    return { stdout: args[0] === "--version" ? execution.version : "serve help", stderr: "" };
  });
  // Native execFile has a custom promisifier returning both output streams.
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: execFile, configurable: true });
  return { execFile };
});
import { execFile } from "node:child_process";
import { OpenCodeRuntimeAdapter } from "./opencode-runtime-adapter.js";

beforeEach(() => {
  vi.clearAllMocks();
  execution.version = "1.18.30";
  execution.serveError = false;
});

describe("OpenCode executable health", () => {
  it.each(["1.18.27", "1.18.30", "1.18.100", "1.19.0", "2.0.0"])("accepts stable version %s and probes serve", async (version) => {
    execution.version = version;
    const adapter = new OpenCodeRuntimeAdapter({ executable: "/opencode" });
    await expect(adapter.health()).resolves.toMatchObject({ available: true, version });
    expect(vi.mocked(execFile).mock.calls.map((call) => call[1])).toEqual([["--version"], ["serve", "--help"]]);
  });

  it.each(["1.18.26", "1.18.9", "1.17.99", "0.99.99", "dev", "1.19.0-beta.1", "01.19.0"])("blocks unsupported version %s before starting a server", async (version) => {
    execution.version = version;
    const adapter = new OpenCodeRuntimeAdapter({ executable: "/opencode" });
    await expect(adapter.create({ cwd: "/repo", title: "compatibility test" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("blocks a newer binary that cannot serve", async () => {
    execution.serveError = true;
    const adapter = new OpenCodeRuntimeAdapter({ executable: "/opencode" });
    await expect(adapter.health()).resolves.toMatchObject({ available: false, error: "serve unavailable" });
    await expect(adapter.create({ cwd: "/repo", title: "compatibility test" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});
