import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getActiveTrigger } from "./palette.js";
import { indexProjectResources, mergeProjects, replaceMentionToken, scanSiblingProjects } from "./resources.js";

describe("resource candidates", () => {
  it("indexes files and folders while ignoring dependency and build directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-resources-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
    await mkdir(path.join(root, ".next"));
    await writeFile(path.join(root, "src", "main.ts"), "export {};");
    await writeFile(path.join(root, "node_modules", "hidden", "x.js"), "");

    const result = await indexProjectResources(root);
    expect(result.items.map((item) => item.value)).toEqual(["src", "src/main.ts"]);
    expect(result.warnings).toEqual([]);
  });

  it("skips macOS system directories when indexing from the home directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-home-resources-"));
    await mkdir(path.join(root, "Library", "Daemon Containers"), { recursive: true });
    await mkdir(path.join(root, "workspace"));
    await writeFile(path.join(root, "Library", "Daemon Containers", "private.db"), "");
    await writeFile(path.join(root, "workspace", "main.ts"), "export {};");

    const result = await indexProjectResources(root, { homeDirectory: root });
    expect(result.items.map((item) => item.value)).toEqual(["workspace", "workspace/main.ts"]);
    expect(result.warnings).toEqual([]);
  });

  it("merges registered projects and disables records without a real directory", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "tui-projects-"));
    const current = path.join(parent, "customer-agent");
    await mkdir(current);
    await mkdir(path.join(parent, "refund"));
    await mkdir(path.join(parent, "refund", ".git"));
    const discovered = await scanSiblingProjects(current);
    const merged = await mergeProjects(discovered, [
      { id: "r1", name: "refund", description: "", source: "test" },
      { id: "r2", name: "missing", description: "", source: "test" },
    ]);
    expect(merged.filter((item) => item.label === "refund")).toHaveLength(1);
    expect(merged.find((item) => item.label === "missing")?.disabled).toBe(true);
  });

  it("quotes whitespace and replaces only the active mention token", () => {
    const buffer = "inspect @src/old later";
    const cursor = "inspect @src/old".length;
    const trigger = getActiveTrigger(buffer, cursor)!;
    expect(replaceMentionToken(buffer, cursor, trigger, "docs/My File.md")).toEqual({
      buffer: 'inspect @"docs/My File.md"  later',
      cursor: 'inspect @"docs/My File.md" '.length,
    });
  });
});
