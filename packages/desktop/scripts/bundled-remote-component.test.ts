import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MacRemoteHelperApp } from "../../server/lib/remote-control/macos-helper-app.mjs";
import { prepareBundledMacRemoteComponent } from "./bundled-remote-component.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "agentroam-desktop-component-test-"));
  roots.push(root);
  const path = join(root, "Services.noindex", "AgentRoam Remote Desktop.app");
  return { root, managed: new MacRemoteHelperApp({ sourcePath: path, appPath: path }) };
}

it.skipIf(process.platform !== "darwin")("prepares only the verified Mac helper from the desktop archive without installing the CLI", async () => {
  const { root, managed } = await workspace();
  const version = "0.2.0-preview.80";
  const native = join(root, "package/runtime/native/Support.noindex");
  const app = join(native, "AgentRoam Remote Desktop.app");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "payload"), "desktop helper");
  await writeFile(join(native, "unrelated"), "another runtime file");
  const archive = join(root, "runtime.tgz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", root, "package"]);
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1, target: "darwin-arm64", launcherVersion: version,
    packages: [
      { name: "agentroam", file: "launcher.tgz", version, sha256: "0".repeat(64) },
      { name: "agentroam-runtime-darwin-arm64", file: "runtime.tgz", version, sha256 },
    ],
  }));
  const prepare = vi.fn(async (path: string, permission?: string) => {
    expect(permission).toBe("screen");
    expect(await readFile(join(path, "payload"), "utf8")).toBe("desktop helper");
    await expect(access(join(dirname(path), "unrelated"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  await prepareBundledMacRemoteComponent(root, version, version, "screen", { managed, prepare });
  await expect(access(prepare.mock.calls[0][0])).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(archive, "changed since packaging");
  await expect(prepareBundledMacRemoteComponent(root, version, version, "screen", { managed, prepare })).rejects.toThrow("integrity check failed");
  expect(prepare).toHaveBeenCalledOnce();
});

it("reuses the installed newer component when an older desktop opens its authorization panel", async () => {
  const { root, managed } = await workspace();
  const contents = join(managed.appPath, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"));
  await writeFile(join(contents, "MacOS/agentroam-remote-desktop"), "installed executable");
  await writeFile(join(contents, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.agentroam.remote-desktop</string>");
  await writeFile(join(contents, "Resources/agentroam-component.json"), JSON.stringify({ bundleId: "com.agentroam.remote-desktop", version: "0.2.0-preview.81" }));
  const prepare = vi.fn(async () => {});
  await prepareBundledMacRemoteComponent(root, "0.2.0", "0.2.0-preview.80", undefined, { managed, prepare });
  expect(prepare).not.toHaveBeenCalled();
  await prepareBundledMacRemoteComponent(root, "0.2.0", "0.2.0-preview.80", "accessibility", { managed, prepare });
  expect(prepare).toHaveBeenCalledWith(managed.appPath, "accessibility");
});
