import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGED_NODE_VERSION,
  NODE_RUNTIME_ASSETS,
  detectNodeRuntimeTarget,
  ensureManagedNode,
  managedNodeExecutable,
  managedNodeNpmCli,
  type NodeRuntimeTarget,
} from "./node-runtime-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed Node.js runtime", () => {
  it("uses the exact official manifest", () => {
    expect(MANAGED_NODE_VERSION).toBe("22.22.0");
    expect(NODE_RUNTIME_ASSETS["darwin-arm64"]).toEqual({
      archive: "node-v22.22.0-darwin-arm64.tar.xz",
      sha256: "2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac",
      archiveRoot: "node-v22.22.0-darwin-arm64",
    });
    expect(NODE_RUNTIME_ASSETS["windows-amd64"].archive).toBe("node-v22.22.0-win-x64.zip");
  });

  it("selects only supported managed targets", () => {
    expect(detectNodeRuntimeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectNodeRuntimeTarget("win32", "x64")).toBe("windows-amd64");
    expect(() => detectNodeRuntimeTarget("darwin", "x64")).toThrow("unsupported");
    expect(() => detectNodeRuntimeTarget("linux", "x64")).toThrow("unsupported");
  });

  it("reuses a validated cached runtime", async () => {
    const dataDir = await temporaryRoot();
    await fakeRuntime(dataDir, "darwin-arm64");
    const download = vi.fn();
    const resolution = await ensureManagedNode({
      dataDir,
      target: "darwin-arm64",
      dependencies: { download, run: versionRunner() },
    });
    expect(resolution.executable).toBe(managedNodeExecutable(dataDir, "darwin-arm64"));
    expect(resolution.npmCli).toBe(managedNodeNpmCli(dataDir, "darwin-arm64"));
    expect(download).not.toHaveBeenCalled();
  });

  it("downloads, extracts, validates, and atomically activates a runtime", async () => {
    const dataDir = await temporaryRoot();
    const download = vi.fn(async (_url: string, destination: string) => writeFile(destination, "archive"));
    const run = extractionRunner("darwin-arm64");
    const resolution = await ensureManagedNode({
      dataDir,
      target: "darwin-arm64",
      dependencies: {
        download,
        sha256: async () => NODE_RUNTIME_ASSETS["darwin-arm64"].sha256,
        run,
      },
    });
    expect(download).toHaveBeenCalledWith(
      "https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.xz",
      expect.any(String),
      10 * 60_000,
    );
    expect(resolution.version).toBe(MANAGED_NODE_VERSION);
    expect(await readFile(resolution.npmCli, "utf8")).toBe("npm");
  });

  it("rejects a checksum mismatch and cleans temporary state", async () => {
    const dataDir = await temporaryRoot();
    await expect(ensureManagedNode({
      dataDir,
      target: "darwin-arm64",
      dependencies: {
        download: async (_url, destination) => writeFile(destination, "bad"),
        sha256: async () => "bad-checksum",
      },
    })).rejects.toThrow("checksum mismatch");
    expect(await readdir(resolve(dataDir, "runtimes", "node"))).toEqual([]);
  });

  it("rejects an unexpected archive root", async () => {
    const dataDir = await temporaryRoot();
    await expect(ensureManagedNode({
      dataDir,
      target: "darwin-arm64",
      dependencies: {
        download: async (_url, destination) => writeFile(destination, "archive"),
        sha256: async () => NODE_RUNTIME_ASSETS["darwin-arm64"].sha256,
        run: async (command, args) => {
          if (command === "/usr/bin/tar") await mkdir(resolve(args[args.indexOf("-C") + 1], "wrong-root"));
          return { stdout: "", stderr: "" };
        },
      },
    })).rejects.toThrow("unexpected Node.js archive root");
  });

  it("rejects a runtime that reports the wrong version", async () => {
    const dataDir = await temporaryRoot();
    const run = extractionRunner("darwin-arm64", "v22.21.0");
    await expect(ensureManagedNode({
      dataDir,
      target: "darwin-arm64",
      dependencies: {
        download: async (_url, destination) => writeFile(destination, "archive"),
        sha256: async () => NODE_RUNTIME_ASSETS["darwin-arm64"].sha256,
        run,
      },
    })).rejects.toThrow("validation failed");
  });

  it("serializes concurrent installs", async () => {
    const dataDir = await temporaryRoot();
    let downloads = 0;
    const dependencies = {
      download: async (_url: string, destination: string) => {
        downloads += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        await writeFile(destination, "archive");
      },
      sha256: async () => NODE_RUNTIME_ASSETS["darwin-arm64"].sha256,
      run: extractionRunner("darwin-arm64"),
    };
    const [first, second] = await Promise.all([
      ensureManagedNode({ dataDir, target: "darwin-arm64", dependencies }),
      ensureManagedNode({ dataDir, target: "darwin-arm64", dependencies }),
    ]);
    expect(downloads).toBe(1);
    expect(second.executable).toBe(first.executable);
  });

  it("recovers a stale lock", async () => {
    const dataDir = await temporaryRoot();
    const lockPath = resolve(dataDir, "runtimes", "node", `${MANAGED_NODE_VERSION}.lock`);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "stale");
    await utimes(lockPath, new Date(0), new Date(0));
    const resolution = await ensureManagedNode({
      dataDir,
      target: "darwin-arm64",
      staleLockMs: 1,
      dependencies: {
        download: async (_url, destination) => writeFile(destination, "archive"),
        sha256: async () => NODE_RUNTIME_ASSETS["darwin-arm64"].sha256,
        run: extractionRunner("darwin-arm64"),
      },
    });
    expect(resolution.version).toBe(MANAGED_NODE_VERSION);
  });

  it("uses the Windows executable and npm layout", async () => {
    const dataDir = await temporaryRoot();
    await fakeRuntime(dataDir, "windows-amd64");
    await expect(ensureManagedNode({
      dataDir,
      target: "windows-amd64",
      dependencies: { run: versionRunner() },
    })).resolves.toMatchObject({
      executable: managedNodeExecutable(dataDir, "windows-amd64"),
      npmCli: managedNodeNpmCli(dataDir, "windows-amd64"),
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "agentroam-node-runtime-"));
  temporaryDirectories.push(root);
  return root;
}

async function fakeRuntime(dataDir: string, target: NodeRuntimeTarget): Promise<void> {
  const executable = managedNodeExecutable(dataDir, target);
  const npmCli = managedNodeNpmCli(dataDir, target);
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(dirname(npmCli), { recursive: true });
  await writeFile(executable, "node");
  await writeFile(npmCli, "npm");
}

function versionRunner(version = `v${MANAGED_NODE_VERSION}`) {
  return async () => ({ stdout: `${version}\n`, stderr: "" });
}

function extractionRunner(target: NodeRuntimeTarget, version = `v${MANAGED_NODE_VERSION}`) {
  return vi.fn(async (command: string, args: string[]) => {
    if (command === "/usr/bin/tar" || command === "powershell.exe") {
      const extractRoot = command === "/usr/bin/tar"
        ? args[args.indexOf("-C") + 1]
        : args.at(-1)!;
      const archiveRoot = resolve(extractRoot, NODE_RUNTIME_ASSETS[target].archiveRoot);
      const executable = target === "windows-amd64"
        ? resolve(archiveRoot, "node.exe")
        : resolve(archiveRoot, "bin", "node");
      const npmCli = target === "windows-amd64"
        ? resolve(archiveRoot, "node_modules", "npm", "bin", "npm-cli.js")
        : resolve(archiveRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      await mkdir(dirname(executable), { recursive: true });
      await mkdir(dirname(npmCli), { recursive: true });
      await writeFile(executable, "node");
      await writeFile(npmCli, "npm");
      return { stdout: "", stderr: "" };
    }
    return { stdout: `${version}\n`, stderr: "" };
  });
}
