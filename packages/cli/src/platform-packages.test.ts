import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEPENDENCY_VERSIONS,
  requirePlatformPackages,
  resolvePlatformRuntime,
  resolvePlatformTui,
} from "./platform-packages.js";

describe("platform packages", () => {
  it("maps macOS arm64 and Windows x64 package names", () => {
    expect(requirePlatformPackages("darwin-arm64")).toEqual({
      runtime: "agentroam-runtime-darwin-arm64",
      cloudflared: "agentroam-cloudflared-darwin-arm64",
      tui: "agentroam-tui-darwin-arm64",
    });
    expect(requirePlatformPackages("windows-amd64")).toEqual({
      runtime: "agentroam-runtime-win32-x64",
      cloudflared: "agentroam-cloudflared-win32-x64",
      tui: "@caoqu/agentroam-tui-win32-x64",
    });
  });

  it("rejects targets without a published package set", () => {
    expect(() => requirePlatformPackages("darwin-amd64")).toThrow("unavailable for darwin-amd64");
  });

  it("resolves a matching runtime manifest", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentroam-runtime-resolver-"));
    const manifestPath = resolve(root, "manifest.json");
    const runtimePackageJson = resolve(root, "runtime/package.json");
    mkdirSync(dirname(runtimePackageJson), { recursive: true });
    writeFileSync(runtimePackageJson, "{}");
    writeFileSync(manifestPath, JSON.stringify({
      packageVersion: PLATFORM_DEPENDENCY_VERSIONS["agentroam-runtime-win32-x64"],
      target: "windows-amd64",
      schemaVersion: 2,
      minimumNodeVersion: "22.22.0",
      nativeFiles: { "node_modules/example.node": "a".repeat(64) },
    }));

    const resolved = resolvePlatformRuntime("windows-amd64", fakeRequire({
      "/manifest.json": manifestPath,
      "/runtime": runtimePackageJson,
    }));
    expect(resolved.runtimeRoot).toBe(dirname(runtimePackageJson));
    expect(resolved.manifest.target).toBe("windows-amd64");
  });

  it("rejects mismatched runtime versions and targets", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentroam-runtime-invalid-"));
    const manifestPath = resolve(root, "manifest.json");
    const runtimePackageJson = resolve(root, "runtime/package.json");
    mkdirSync(dirname(runtimePackageJson), { recursive: true });
    writeFileSync(runtimePackageJson, "{}");
    writeFileSync(manifestPath, JSON.stringify({
      packageVersion: "0.0.0",
      target: "darwin-arm64",
      schemaVersion: 2,
      minimumNodeVersion: "22.22.0",
      nativeFiles: {},
    }));
    expect(() => resolvePlatformRuntime("windows-amd64", fakeRequire({
      "/manifest.json": manifestPath,
      "/runtime": runtimePackageJson,
    }))).toThrow("invalid AgentRoam runtime manifest");
  });

  it("resolves the target TUI entry", () => {
    const entry = resolvePlatformTui("windows-amd64", fakeRequire({ "/entry": "C:\\agentroam\\agent-tui.js" }));
    expect(entry).toBe("C:\\agentroam\\agent-tui.js");
  });

  it("rejects legacy ABI manifests even when their release version matches", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentroam-runtime-legacy-"));
    const manifestPath = resolve(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      packageVersion: PLATFORM_DEPENDENCY_VERSIONS["agentroam-runtime-darwin-arm64"], target: "darwin-arm64",
      nodeMajor: 22, nodeModuleAbi: 127, nativeFiles: {},
    }));
    expect(() => resolvePlatformRuntime("darwin-arm64", fakeRequire({
      "/manifest.json": manifestPath, "/runtime": resolve(root, "runtime/package.json"),
    }))).toThrow("invalid AgentRoam runtime manifest");
  });
});

function fakeRequire(suffixes: Record<string, string>): NodeRequire {
  return {
    resolve(id: string) {
      for (const [suffix, value] of Object.entries(suffixes)) {
        if (id.endsWith(suffix)) return value;
      }
      throw Object.assign(new Error(`missing ${id}`), { code: "MODULE_NOT_FOUND" });
    },
  } as NodeRequire;
}
