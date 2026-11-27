import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QoderDesktopActivityReader } from "./qoder-desktop-activity.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const startedAt = Date.parse("2026-11-17T06:00:00Z");
const session = { id: "native-1" };
function event(kind = "started", turn = "main-1", time = 1, attributes = "is_subagent=false") {
  return `${new Date(startedAt + time).toISOString()} INFO  [session=${session.id} turn=${turn}] turn.${kind} ${attributes}\n`;
}

async function fixture(content = event()) {
  const home = await mkdtemp(join(tmpdir(), "qoder-activity-")); homes.push(home);
  const root = join(home, ".qoder/logs/runs");
  const directory = join(root, "native-p412");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ pid: 412, started_at: new Date(startedAt).toISOString() }));
  const log = join(directory, "qodercli.log");
  await writeFile(log, content);
  const processes = new Map([[412, startedAt]]);
  const reader = new QoderDesktopActivityReader({ home, processStarts: async () => processes });
  return { home, root, directory, log, processes, reader };
}

describe("Qoder external turn activity", () => {
  it("recognizes a main turn without borrowing activity for another session", async () => {
    const { reader } = await fixture();
    expect(await reader.readMany([session, { id: "other" }])).toEqual(new Map([[session.id, true]]));
  });

  it.each(["end_turn", "abort", "error"])("settles the exact main turn on %s", async reason => {
    const { reader, log } = await fixture();
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, event("finished", "main-1", 2, `reason="${reason}"`));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("keeps the parent running while its subagent starts and finishes", async () => {
    const { reader, log } = await fixture();
    await appendFile(log, event("started", "child", 2, "is_subagent=true") + event("finished", "child", 3));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, event("finished", "main-1", 4));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
    await appendFile(log, event("started", "child-2", 5, "is_subagent=true"));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("does not let a late previous completion stop a newer main turn", async () => {
    const { reader } = await fixture(event() + event("started", "main-2", 2) + event("finished", "main-1", 3));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });

  it("drops activity when the owning process exits or its PID is reused", async () => {
    const { reader, processes } = await fixture();
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    processes.clear();
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
    processes.set(412, startedAt + 60_000);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it("waits for a complete line, handles oversized records, and recovers after truncation", async () => {
    const { reader, log } = await fixture(event().trimEnd());
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
    await appendFile(log, "\n" + "x".repeat(160 * 1024) + "\n" + event("finished", "main-1", 2));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
    await writeFile(log, event("started", "main-2", 3));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });

  it("resets replaced logs and clears deleted owners", async () => {
    const { reader, log } = await fixture();
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await rename(log, `${log}.old`);
    await writeFile(log, event("started", "new", 2) + event("finished", "new", 3));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
    await rm(log);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it("uses the newer main turn across owners, rather than a late older completion", async () => {
    const { reader, root, log, processes } = await fixture();
    const directory = join(root, "another-p413");
    await mkdir(directory);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ pid: 413, started_at: new Date(startedAt).toISOString() }));
    await writeFile(join(directory, "qodercli.log"), event("started", "new", 2));
    processes.set(413, startedAt);
    await appendFile(log, event("finished", "main-1", 3));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });
});
