import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_RUNTIME_VERSION,
  managedOpenCodeBinaryCandidates,
  parseOpenCodeVersion,
  resolveOpenCodeRuntime,
} from "./opencode-runtime-manager.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executable(name = "opencode") {
  const root = await mkdtemp(join(tmpdir(), "agentroam-opencode-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return { root, path };
}

describe("resolveOpenCodeRuntime", () => {
  it("prefers a compatible absolute override", async () => {
    const binary = await executable();
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "--version" ? `opencode ${OPENCODE_RUNTIME_VERSION}` : "help",
      stderr: "",
    }));
    await expect(resolveOpenCodeRuntime({
      dataDir: binary.root,
      target: "darwin-arm64",
      environment: { AGENT_OPENCODE_BIN: binary.path, PATH: "" },
      platform: "darwin",
      dependencies: { run },
    })).resolves.toEqual({ executable: binary.path, version: OPENCODE_RUNTIME_VERSION, source: "explicit" });
    expect(run).toHaveBeenCalledWith(binary.path, ["serve", "--help"], 5_000);
  });

  it("rejects relative explicit overrides", async () => {
    await expect(resolveOpenCodeRuntime({
      dataDir: "/data",
      target: "darwin-arm64",
      environment: { AGENT_OPENCODE_BIN: "opencode", PATH: "" },
      platform: "darwin",
    })).rejects.toThrow("absolute path");
  });

  it("uses a compatible PATH executable", async () => {
    const binary = await executable();
    await expect(resolveOpenCodeRuntime({
      dataDir: join(binary.root, "data"),
      target: "darwin-arm64",
      environment: { PATH: binary.root },
      platform: "darwin",
      dependencies: { run: async () => ({ stdout: OPENCODE_RUNTIME_VERSION, stderr: "" }) },
    })).resolves.toMatchObject({ executable: binary.path, source: "global" });
  });

  it("reuses a validated managed installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroam-opencode-managed-"));
    roots.push(root);
    const managedRoot = join(root, "runtimes", "opencode", OPENCODE_RUNTIME_VERSION);
    const candidate = managedOpenCodeBinaryCandidates(managedRoot, "darwin")[0];
    await mkdir(join(candidate, ".."), { recursive: true });
    await writeFile(candidate, "#!/bin/sh\nexit 0\n");
    await chmod(candidate, 0o755);
    await expect(resolveOpenCodeRuntime({
      dataDir: root,
      target: "darwin-arm64",
      environment: { PATH: "" },
      platform: "darwin",
      dependencies: { run: async () => ({ stdout: OPENCODE_RUNTIME_VERSION, stderr: "" }) },
    })).resolves.toEqual({ executable: candidate, version: OPENCODE_RUNTIME_VERSION, source: "managed" });
  });
});

describe("OpenCode runtime helpers", () => {
  it("parses only semantic versions", () => {
    expect(parseOpenCodeVersion("opencode 1.18.27")).toBe("1.18.27");
    expect(parseOpenCodeVersion("dev")).toBeNull();
  });

  it("keeps managed binary candidates under the runtime root", () => {
    expect(managedOpenCodeBinaryCandidates("/data/runtime", "darwin")[0])
      .toBe("/data/runtime/node_modules/opencode-ai/bin/opencode.exe");
    expect(managedOpenCodeBinaryCandidates("C:\\runtime", "win32").some((path) => path.endsWith("opencode.cmd"))).toBe(true);
  });
});
