import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The preflight intentionally remains plain ESM for Node 18 bootstrap.
import { parsePreflightDataDir, runNodePreflight } from "../bin/node-preflight.mjs";

describe("Node launcher preflight", () => {
  it("passes through any Node 22 patch without installing", async () => {
    const ensureNode = vi.fn();
    await expect(runNodePreflight({ nodeVersion: "22.1.0", ensureNode })).resolves.toEqual({ handled: false });
    expect(ensureNode).not.toHaveBeenCalled();
  });

  it.each(["18.20.0", "20.18.0", "24.0.0", "25.1.0"])(
    "re-executes Node %s through the managed runtime",
    async (nodeVersion) => {
      const child = fakeChild(0, null);
      const ensureNode = vi.fn(async () => ({ executable: "/managed/node", version: "22.22.0" }));
      const spawnChild = vi.fn((_executable: string, _args: string[], _options: object) => child);
      const result = await runNodePreflight({
        argv: ["doctor", "--data-dir", "./custom"],
        nodeVersion,
        platform: "darwin",
        arch: "arm64",
        launcherPath: "/launcher/agentroam.mjs",
        environment: { PATH: "" },
        ensureNode,
        findSystemNode22: async () => null,
        spawnChild,
        processHost: fakeProcessHost(),
      });
      expect(result).toEqual({ handled: true, exitCode: 0, signal: null });
      expect(ensureNode).toHaveBeenCalledWith(expect.objectContaining({
        dataDir: resolve("./custom"),
        target: "darwin-arm64",
      }));
      expect(spawnChild).toHaveBeenCalledWith(
        "/managed/node",
        ["/launcher/agentroam.mjs", "doctor", "--data-dir", "./custom"],
        expect.objectContaining({
          stdio: "inherit",
          env: expect.objectContaining({ AGENTROAM_MANAGED_NODE: "22.22.0" }),
        }),
      );
    },
  );

  it("reuses another visible system Node 22", async () => {
    const ensureNode = vi.fn();
    const spawnChild = vi.fn((_executable: string, _args: string[], _options: object) => fakeChild(7, null));
    await expect(runNodePreflight({
      argv: ["version"],
      nodeVersion: "25.0.0",
      platform: "win32",
      arch: "x64",
      environment: { PATH: "" },
      findSystemNode22: async () => "C:\\Node22\\node.exe",
      ensureNode,
      spawnChild,
      processHost: fakeProcessHost(),
    })).resolves.toMatchObject({ handled: true, exitCode: 7 });
    expect(ensureNode).not.toHaveBeenCalled();
    expect(spawnChild.mock.calls[0][0]).toBe("C:\\Node22\\node.exe");
  });

  it("rejects a failed managed re-entry instead of looping", async () => {
    await expect(runNodePreflight({
      nodeVersion: "25.0.0",
      environment: { AGENTROAM_MANAGED_NODE: "22.22.0" },
    })).rejects.toMatchObject({ message: expect.stringContaining("re-entry failed"), exitCode: 2 });
  });

  it("directs old Node versions to the standalone installer", async () => {
    await expect(runNodePreflight({
      nodeVersion: "16.20.0",
      platform: "darwin",
      environment: {},
    })).rejects.toThrow("install-agentroam.sh");
    await expect(runNodePreflight({
      nodeVersion: "12.0.0",
      platform: "win32",
      environment: {},
    })).rejects.toThrow("install-agentroam.ps1");
  });

  it("forwards termination signals and propagates a child signal", async () => {
    const processHost = fakeProcessHost();
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    const running = runNodePreflight({
      nodeVersion: "20.0.0",
      platform: "darwin",
      arch: "arm64",
      environment: { PATH: "" },
      findSystemNode22: async () => "/node22",
      spawnChild: () => child,
      processHost,
    });
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    processHost.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", null, "SIGTERM");
    await expect(running).resolves.toEqual({ handled: true, exitCode: null, signal: "SIGTERM" });
  });

  it("parses data directory overrides before the CLI import", () => {
    expect(parsePreflightDataDir(["start", "--data-dir", "./data"], {}, "/home/me")).toBe(resolve("./data"));
    expect(parsePreflightDataDir([], { AGENTROAM_DATA_DIR: "/custom" }, "/home/me")).toBe("/custom");
    expect(parsePreflightDataDir([], {}, "/home/me")).toBe(resolve("/home/me", ".agentroam"));
    expect(() => parsePreflightDataDir(["--data-dir"], {}, "/home/me")).toThrow("missing value");
  });
});

function fakeChild(exitCode: number | null, signal: string | null) {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  setImmediate(() => child.emit("exit", exitCode, signal));
  return child;
}

function fakeProcessHost() {
  const host = new EventEmitter() as EventEmitter & { stderr: { write: ReturnType<typeof vi.fn> } };
  host.stderr = { write: vi.fn() };
  return host;
}
