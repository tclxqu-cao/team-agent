import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverWorkBuddyDesktopProductConfig } from "./workbuddy-desktop-config.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const app = "/Applications/WorkBuddy.app/Contents/MacOS/Electron";
const daemon = `${app} /Applications/WorkBuddy.app/Contents/Resources/app.asar/main/daemon-app-server-entry.js --stdio`;
const processes = `100 1 ${app}\n200 100 ${daemon}\n300 1 /usr/bin/node unrelated.js\n`;
const product = { models: [{ id: "desktop-model", name: "Desktop model" }], agents: [{ name: "cli", tags: ["cli", "default"], models: ["desktop-model"] }] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-desktop-config-")); roots.push(root);
  const cache = join(root, "cache"); await mkdir(cache);
  const snapshot = async (pid: number, suffix: string, value: unknown = product) => {
    const path = join(cache, `acc-product-config-v3-${pid}-${suffix}.json`);
    await writeFile(path, JSON.stringify(value)); return path;
  };
  const execute = vi.fn(async () => ({ stdout: processes }));
  return { root, cache, snapshot, execute, discover: () => discoverWorkBuddyDesktopProductConfig({ configDir: root, platform: "darwin", execute }) };
}

describe("WorkBuddy desktop product configuration", () => {
  it("uses the live desktop daemon rather than newer bootstrap, dead or unrelated process snapshots", async () => {
    const f = await fixture();
    const desktop = await f.snapshot(200, "aa"); await utimes(desktop, 1, 1);
    await f.snapshot(100, "bb");
    await f.snapshot(300, "cc");
    await f.snapshot(400, "dd");
    expect(await f.discover()).toBe(desktop);
  });

  it("selects the latest valid snapshot from the live desktop daemon", async () => {
    const f = await fixture(); const old = await f.snapshot(200, "aa"); await utimes(old, 1, 1);
    const current = await f.snapshot(200, "bb");
    expect(await f.discover()).toBe(current);
  });

  it("does not accept a standalone daemon without its matching WorkBuddy desktop parent", async () => {
    const f = await fixture(); await f.snapshot(200, "aa");
    f.execute.mockResolvedValue({ stdout: `100 1 /usr/bin/node\n200 100 ${daemon}` });
    expect(await f.discover()).toBeNull();
  });

  it.each([null, [], {}, { models: [], agents: product.agents }, { models: product.models, agents: [] }])("ignores an incomplete configuration (%j)", async value => {
    const f = await fixture(); await f.snapshot(200, "aa", value);
    expect(await f.discover()).toBeNull();
  });

  it("does not follow snapshot symlinks", async () => {
    const f = await fixture(); const elsewhere = join(f.root, "other.json");
    await writeFile(elsewhere, JSON.stringify(product));
    await symlink(elsewhere, join(f.cache, "acc-product-config-v3-200-aa.json"));
    expect(await f.discover()).toBeNull();
  });

  it("returns unavailable if process discovery fails or the desktop cache is absent", async () => {
    const f = await fixture(); f.execute.mockRejectedValue(new Error("permission denied"));
    expect(await f.discover()).toBeNull();
    f.execute.mockResolvedValue({ stdout: processes }); await rm(f.cache, { recursive: true });
    expect(await f.discover()).toBeNull();
  });

  it("does not run macOS process discovery on another platform", async () => {
    const f = await fixture();
    expect(await discoverWorkBuddyDesktopProductConfig({ configDir: f.root, platform: "win32", execute: f.execute })).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
