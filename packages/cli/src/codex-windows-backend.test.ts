import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureWindowsBackend, readWindowsBackend, validateWindowsBackend, windowsBackendPath } from "./codex-windows-backend.js";

const executable = "C:\\Users\\test\\codex.exe";
const codexHome = "C:\\Users\\test\\.codex";
describe("Windows managed shared backend", () => {
  it("provisions a protected per-user login task and reuses the capability URL", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-win-"));
    const execute = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const probe = vi.fn(async () => {});
    const context = { homeDir, environment: { CODEX_HOME: codexHome }, execute: execute as never,
      resolveExecutable: async () => executable, probe, allocatePort: async () => 45123 };
    try {
      const first = await ensureWindowsBackend(homeDir, context);
      const second = await ensureWindowsBackend(homeDir, context);
      expect(second.endpoint).toBe(first.endpoint);
      expect(await readWindowsBackend(homeDir)).toEqual(first);
      expect(first.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:45123\/[a-f0-9]{48}$/);
      const scripts = JSON.stringify(execute.mock.calls);
      expect(scripts).toContain("icacls"); expect(scripts).toContain("AtLogOn");
      expect(scripts).toContain("IgnoreNew"); expect(scripts).toContain("RunLevel Limited");
      expect(scripts).not.toContain("Stop-Process"); expect(scripts).not.toContain("Start-Process");
      expect(probe).toHaveBeenCalledTimes(2);
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });
  it("preserves desktop and releases its setup lock when readiness fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-win-"));
    try {
      const execute = vi.fn(async () => ({ stdout: "", stderr: "" }));
      await expect(ensureWindowsBackend(homeDir, { homeDir, environment: { CODEX_HOME: codexHome }, execute: execute as never,
        resolveExecutable: async () => executable, allocatePort: async () => 45124,
        probe: async () => { throw new Error("offline"); }, wait: async () => {} })).rejects.toThrow("未就绪");
      await expect(readFile(`${windowsBackendPath(homeDir)}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(execute.mock.calls)).not.toContain("Stop-Process");
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });
  it("rejects corrupt or remote persisted configurations", async () => {
    expect(() => validateWindowsBackend({ version: 1, endpoint: `ws://remote:123/${"a".repeat(48)}`, executable, codexHome })).toThrow();
    expect(() => validateWindowsBackend(null)).toThrow();
  });
});
