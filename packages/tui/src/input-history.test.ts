import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendInputHistory, loadInputHistory } from "./input-history.js";

describe("input history persistence", () => {
  it("loads sanitised entries and tolerates a missing file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tui-history-"));
    expect(await loadInputHistory(path.join(dir, "missing.json"))).toEqual([]);

    const file = path.join(dir, "history.json");
    await writeFile(file, JSON.stringify(["a", "a", "  ", "b", 5]), "utf8");
    expect(await loadInputHistory(file)).toEqual(["a", "b"]);
  });

  it("appends entries, skips consecutive duplicates, and caps at 500", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tui-history-"));
    const file = path.join(dir, "history.json");
    const seeded = Array.from({ length: 500 }, (_, index) => `entry-${index}`);

    await writeFile(file, JSON.stringify(seeded), "utf8");
    let history = await loadInputHistory(file);
    history = await appendInputHistory(file, history, "entry-499");
    expect(history.length).toBe(500);
    expect(history.at(-1)).toBe("entry-499");

    history = await appendInputHistory(file, history, "newest");
    expect(history.length).toBe(500);
    expect(history[0]).toBe("entry-1");
    expect(history.at(-1)).toBe("newest");

    const stored = JSON.parse(await readFile(file, "utf8")) as string[];
    expect(stored.at(-1)).toBe("newest");
    expect(await appendInputHistory(file, history, "   ")).toBe(history);
  });
});
