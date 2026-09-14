import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cleanupOldLaunchers } from "./launcher-cleanup.js";
import type { ServiceConfig } from "./service-files.js";
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await realpath(await mkdtemp(resolve(tmpdir(), "launcher-cleanup-"))); temporary.push(dataDir);
  async function install(version: string) {
    const root = resolve(dataDir, "launcher", version);
    const pkg = resolve(root, "node_modules/agentroam");
    await mkdir(resolve(pkg, "bin"), { recursive: true });
    await writeFile(resolve(pkg, "package.json"), JSON.stringify({ name: "agentroam", version }));
    await writeFile(resolve(pkg, "bin/agentroam.mjs"), "// fixture"); return root;
  }
  const current = await install("0.2.0-preview.19");
  const config = { dataDir, version: "0.2.0-preview.19", cliPath: resolve(current, "node_modules/agentroam/bin/agentroam.mjs"), roots: [] } as unknown as ServiceConfig;
  return { dataDir, current, config, install };
}
it("removes an older managed program while retaining current, newer versions and user data", async () => {
  const f = await fixture(); const old = await f.install("0.2.0-preview.18"); const newer = await f.install("0.2.0-preview.20");
  for (const file of ["config.json", "agent.db", "pairing.db"]) await writeFile(resolve(f.dataDir, file), "preserve");
  await cleanupOldLaunchers(f.config, () => {});
  await expect(readFile(resolve(old, "node_modules/agentroam/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  for (const root of [f.current, newer]) expect(await readFile(resolve(root, "node_modules/agentroam/package.json"), "utf8")).toContain("agentroam");
  for (const file of ["config.json", "agent.db", "pairing.db"]) expect(await readFile(resolve(f.dataDir, file), "utf8")).toBe("preserve");
});
it("preserves project roots, unexpected data, locked installs, and linked versions", async () => {
  const f = await fixture();
  const project = await f.install("0.2.0-preview.15"); f.config.roots = [project];
  const data = await f.install("0.2.0-preview.16"); await writeFile(resolve(data, "session.db"), "preserve");
  const locked = await f.install("0.2.0-preview.17"); await mkdir(`${locked}.lock`);
  await symlink(data, resolve(f.dataDir, "launcher/0.2.0-preview.14"));
  await cleanupOldLaunchers(f.config, () => {});
  for (const root of [project, data, locked]) expect(await readFile(resolve(root, "node_modules/agentroam/package.json"), "utf8")).toContain("agentroam");
});
it("does not clean when the active CLI is outside the managed installation", async () => {
  const f = await fixture(); const old = await f.install("0.2.0-preview.18"); f.config.cliPath = resolve(f.dataDir, "npx/agentroam.mjs");
  await cleanupOldLaunchers(f.config, () => {});
  expect(await readFile(resolve(old, "node_modules/agentroam/package.json"), "utf8")).toContain("agentroam");
});

it.each(["starting", "failed", "ready"])("cleans only after a replacement service is ready (%s)", async (status) => {
  const { runServiceCommand } = await import("./service-command.js");
  const { parseArgs } = await import("../args.js");
  const f = await fixture(); const old = await f.install("0.2.0-preview.18");
  const install = async () => {
    if (status === "failed") throw new Error("activation failed");
    return { definition: "test", state: { status, version: f.config.version } };
  };
  const action = runServiceCommand(parseArgs(["service", "install", "--data-dir", f.dataDir]), {
    platform: "darwin", arch: "arm64", nodeVersion: "25.8.0", nodePath: process.execPath,
    cliPath: f.config.cliPath, version: f.config.version, log: () => {},
    codexResolver: async () => ({ executable: "/test/codex", version: "test", source: "global" }),
    controller: { install } as any,
  });
  if (status === "failed") await expect(action).rejects.toThrow("activation failed"); else await action;
  const manifest = readFile(resolve(old, "node_modules/agentroam/package.json"), "utf8");
  if (status === "ready") await expect(manifest).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await manifest).toContain("agentroam");
});
