import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MANAGED_NODE_VERSION, NODE_RUNTIME_ASSETS } from "./node-runtime-manager.js";
import { MINIMUM_NODE_VERSION, isSupportedNodeVersion } from "../bin/runtime-policy.mjs";

const installRoot = resolve(import.meta.dirname, "../install");

describe("standalone installer contracts", () => {
  it.skipIf(process.platform === "win32")("continues after failed diagnostics but stops when service registration fails", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR || "/tmp", "agentroam-install-diagnostics-"));
    try {
      const script = await readFile(resolve(installRoot, "install-agentroam.sh"), "utf8");
      // Execute the actual post-install flow with a fake CLI, without touching launchd.
      const start = script.indexOf('if ! "$NODE_BIN" "$entry" doctor');
      expect(start).toBeGreaterThan(0);
      const node = resolve(root, "node");
      const calls = resolve(root, "calls");
      await writeFile(node, `#!/bin/sh\nprintf '%s\\n' "$2" >> "$TEST_CALLS"\ncase "$2" in\n doctor) exit 1 ;;\n service) exit "$TEST_SERVICE_EXIT" ;;\nesac\n`);
      await chmod(node, 0o755);
      for (const serviceExit of [0, 1]) {
        await writeFile(calls, "");
        const result = spawnSync("/bin/sh", ["-c", `set -eu\n${script.slice(start)}`], {
          encoding: "utf8",
          env: { ...process.env, NODE_BIN: node, entry: "fake-cli", DATA_DIR: root, SERVICE_ROOT: root,
            WRAPPER_PATH: "agentroam", WRAPPER_DIR: root, AGENTROAM_VERSION: "test",
            AGENTROAM_INSTALL_SKIP_SERVICE: "0", AGENTROAM_INSTALL_DESKTOP: "no",
            TEST_CALLS: calls, TEST_SERVICE_EXIT: String(serviceExit) },
        });
        expect(await readFile(calls, "utf8")).toBe("doctor\nservice\n");
        expect(result.stderr).toContain("some component checks failed");
        expect(result.status).toBe(serviceExit);
        if (serviceExit === 0) expect(result.stdout).toContain("installed:");
        else expect(result.stdout).not.toContain("installed:");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("allows installation from home and keeps a compatible active Node", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR || "/tmp", "agentroam-active-node-"));
    try {
      const homeDir = resolve(root, "home");
      const workspace = resolve(root, "workspace");
      const activeBin = resolve(root, "active bin");
      const nvmRoot = resolve(root, "nvm");
      await Promise.all([mkdir(homeDir), mkdir(workspace), mkdir(activeBin), mkdir(nvmRoot)]);
      const expected = await fakeNode(resolve(activeBin, "node"), "24.13.0");
      await fakeNode(resolve(nvmRoot, "versions/node/v26.0.0/bin/node"), "26.0.0");
      const output = execFileSync("/bin/sh", [resolve(installRoot, "install-agentroam.sh")], {
        cwd: homeDir, encoding: "utf8",
        env: { ...process.env, HOME: homeDir, NVM_DIR: nvmRoot, PATH: `${activeBin}:/usr/bin:/bin`,
          AGENTROAM_BOOTSTRAP_TEST: "1", AGENTROAM_BOOTSTRAP_NODE_DISCOVERY_ONLY: "1" },
      });
      expect(output.trim()).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the macOS installer aligned with the runtime manifest", async () => {
    const scriptPath = resolve(installRoot, "install-agentroam.sh");
    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain(`NODE_VERSION="${MANAGED_NODE_VERSION}"`);
    expect(script).toContain(`MINIMUM_NODE_VERSION="${MINIMUM_NODE_VERSION}"`);
    expect(script).toContain('AGENTROAM_VERSION_REQUEST="${AGENTROAM_VERSION:-preview}"');
    // update-worker 用 AGENTROAM_VERSION 钉死目标版本，这里锁住「以数字结尾 = 精确版本」的分支：
    // 一旦脚本改成别的判定方式，更新流程就可能装出与提示不符的版本。
    expect(script).toContain('AGENTROAM_VERSION="$AGENTROAM_VERSION_REQUEST"');
    expect(script).toContain("*[0-9])");
    expect(script).toContain(NODE_RUNTIME_ASSETS["darwin-arm64"].archive);
    expect(script).toContain(NODE_RUNTIME_ASSETS["darwin-arm64"].sha256);
    expect(script).toContain("https://registry.npmjs.org");
    expect(script).toContain("$HOME/.agentroam");
    expect(script).toContain("$HOME/.local/bin");
    expect(script).toContain('AGENTROAM_ROOT');
    expect(script).toContain('AGENTROAM_INSTALL_SKIP_SERVICE');
    expect(script).toContain('service install --root "$SERVICE_ROOT" --data-dir "$DATA_DIR"');
    expect(script).toContain('SERVICE_ROOT="$PWD"');
    expect(script).toContain("find_nvm_node");
    expect(script).toContain('${NVM_DIR:-}');
    expect(script).not.toMatch(/\b(?:brew|sudo|fnm|volta)\b/);
    execFileSync("sh", ["-n", scriptPath]);
  });

  it("keeps the Windows installer aligned with the runtime manifest", async () => {
    const script = await readFile(resolve(installRoot, "install-agentroam.ps1"), "utf8");
    expect(script).toContain(`$NodeVersion = "${MANAGED_NODE_VERSION}"`);
    expect(script).toContain(`$MinimumNodeVersion = "${MINIMUM_NODE_VERSION}"`);
    expect(script).toContain('$AgentRoamVersionRequest = if ($env:AGENTROAM_VERSION) { $env:AGENTROAM_VERSION } else { "preview" }');
    // 与 .sh 同一条契约：以数字结尾即精确版本，原样采用。
    expect(script).toContain("if ($AgentRoamVersionRequest -notmatch '\\d$')");
    expect(script).toContain("$AgentRoamVersion = $AgentRoamVersionRequest");
    expect(script).toContain(NODE_RUNTIME_ASSETS["windows-amd64"].archive);
    expect(script).toContain(NODE_RUNTIME_ASSETS["windows-amd64"].sha256);
    expect(script).toContain("https://registry.npmjs.org");
    expect(script).toContain(".agentroam\\bin");
    expect(script).toContain('[Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")');
    expect(script).toContain("$env:AGENTROAM_ROOT");
    expect(script).toContain("$env:AGENTROAM_INSTALL_SKIP_SERVICE");
    expect(script).toContain("service install --root $ServiceRoot --data-dir $DataDir");
    expect(script).toContain("(Get-Location).Path");
    expect(script).toContain("Find-NvmNode");
    expect(script).toContain("$env:NVM_HOME");
    expect(script).not.toMatch(/\b(?:winget|choco|scoop|Start-Process\s+.*RunAs)\b/i);
  });

  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "selects the highest compatible NVM Node without changing the active version",
    async () => {
      const root = await mkdtemp(resolve(process.env.TMPDIR || "/tmp", "agentroam-nvm-discovery-"));
      try {
        const home = resolve(root, "home");
        const workspace = resolve(root, "workspace");
        const activeBin = resolve(root, "active-bin");
        const nvmRoot = resolve(root, "nvm root with spaces");
        await Promise.all([mkdir(home), mkdir(workspace), mkdir(activeBin), mkdir(nvmRoot)]);
        await fakeNode(resolve(activeBin, "node"), "20.19.0");
        await fakeNode(resolve(nvmRoot, "versions/node/v22.3.0/bin/node"), "22.3.0");
        await fakeNode(resolve(nvmRoot, "versions/node/v22.22.2/bin/node"), "22.22.2");
        const expected = await fakeNode(resolve(nvmRoot, "versions/node/v25.8.0/bin/node"), "25.8.0");
        await fakeNode(resolve(nvmRoot, "versions/node/v22.99.0/bin/node"), "21.99.0");

        const output = execFileSync("/bin/sh", [resolve(installRoot, "install-agentroam.sh")], {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            NVM_DIR: nvmRoot,
            PATH: `${activeBin}:/usr/bin:/bin`,
            AGENTROAM_BOOTSTRAP_TEST: "1",
            AGENTROAM_BOOTSTRAP_NODE_DISCOVERY_ONLY: "1",
          },
        });

        expect(output.trim().split("\n").at(-1)).toBe(expected);
        expect(output).toContain("Using Node.js v25.8.0 from NVM");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32" || !isSupportedNodeVersion(process.versions.node))(
    "selects a compatible nvm-windows Node when the active PATH has no Node",
    async () => {
      const root = await mkdtemp(resolve(process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp", "agentroam-nvm-windows-"));
      try {
        const home = resolve(root, "home");
        const workspace = resolve(root, "workspace");
        const nvmRoot = resolve(root, "nvm root with spaces");
        const expected = resolve(nvmRoot, `v${process.versions.node}`, "node.exe");
        await Promise.all([
          mkdir(home),
          mkdir(workspace),
          mkdir(resolve(expected, ".."), { recursive: true }),
        ]);
        await copyFile(process.execPath, expected);

        const output = execFileSync("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", resolve(installRoot, "install-agentroam.ps1"),
        ], {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            APPDATA: resolve(root, "appdata"),
            NVM_HOME: nvmRoot,
            PATH: `${process.env.SystemRoot || "C:\\Windows"}\\System32`,
            AGENTROAM_BOOTSTRAP_TEST: "1",
            AGENTROAM_BOOTSTRAP_NODE_DISCOVERY_ONLY: "1",
          },
        });

        expect(output.trim().split(/\r?\n/).at(-1)).toBe(expected);
        expect(output).toContain(`Using Node.js v${process.versions.node} from NVM`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

async function fakeNode(path: string, version: string): Promise<string> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\ncase "$1" in\n  -p) printf '%s\\n' '${version}' ;;\n  --version) printf '%s\\n' 'v${version}' ;;\nesac\n`);
  await chmod(path, 0o755);
  return path;
}
