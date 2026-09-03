import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MANAGED_NODE_VERSION, NODE_RUNTIME_ASSETS } from "./node-runtime-manager.js";
import { AGENTROAM_VERSION } from "./platform-packages.js";

const installRoot = resolve(import.meta.dirname, "../install");

describe("standalone installer contracts", () => {
  it("keeps the macOS installer aligned with the runtime manifest", async () => {
    const scriptPath = resolve(installRoot, "install-agentroam.sh");
    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain(`NODE_VERSION="${MANAGED_NODE_VERSION}"`);
    expect(script).toContain(`AGENTROAM_VERSION="${AGENTROAM_VERSION}"`);
    expect(script).toContain(NODE_RUNTIME_ASSETS["darwin-arm64"].archive);
    expect(script).toContain(NODE_RUNTIME_ASSETS["darwin-arm64"].sha256);
    expect(script).toContain("https://registry.npmjs.org");
    expect(script).toContain("$HOME/.agentroam");
    expect(script).toContain("$HOME/.local/bin");
    expect(script).not.toMatch(/\b(?:brew|sudo|nvm|fnm|volta)\b/);
    execFileSync("sh", ["-n", scriptPath]);
  });

  it("keeps the Windows installer aligned with the runtime manifest", async () => {
    const script = await readFile(resolve(installRoot, "install-agentroam.ps1"), "utf8");
    expect(script).toContain(`$NodeVersion = "${MANAGED_NODE_VERSION}"`);
    expect(script).toContain(`$AgentRoamVersion = "${AGENTROAM_VERSION}"`);
    expect(script).toContain(NODE_RUNTIME_ASSETS["windows-amd64"].archive);
    expect(script).toContain(NODE_RUNTIME_ASSETS["windows-amd64"].sha256);
    expect(script).toContain("https://registry.npmjs.org");
    expect(script).toContain(".agentroam\\bin");
    expect(script).toContain('[Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")');
    expect(script).not.toMatch(/\b(?:winget|choco|scoop|Start-Process\s+.*RunAs)\b/i);
  });
});
