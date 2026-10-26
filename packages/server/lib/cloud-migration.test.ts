import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectMigrationBundle, renderSessionHistory } from "./cloud-migration";

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "asb-mig-"));
  await writeFile(join(root, "README.md"), "# demo");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const x = 1;\n");
  await writeFile(join(root, ".env"), "SECRET=1");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep.js"), "skip me");
  await writeFile(join(root, "logo.png"), "binary");
  return root;
}

describe("collectMigrationBundle", () => {
  it("collects whitelisted text files recursively, skips credentials/deps/binaries", async () => {
    const root = await makeProject();
    const bundle = await collectMigrationBundle(root);
    expect(bundle.files.map((file) => file.path).sort()).toEqual(["README.md", "src/app.ts"]);
    expect(bundle.skipped.some((item) => item.includes(".env"))).toBe(true);
    expect(bundle.totalBytes).toBeGreaterThan(0);
  });

  it("enforces the file count limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-limit-"));
    for (let i = 0; i < 105; i++) {
      await writeFile(join(root, `f${i}.md`), String(i));
    }
    const bundle = await collectMigrationBundle(root);
    expect(bundle.files.length).toBe(100);
  });
});

describe("renderSessionHistory", () => {
  it("renders role-tagged messages with a tail cap", () => {
    const messages = [
      { role: "user", content: "第一条" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "assistant", content: `回复 ${i}` })),
    ];
    const text = renderSessionHistory(messages, { title: "demo", maxMessages: 10 });
    expect(text).toContain("## demo（本地会话迁移）");
    expect(text).toContain("已省略");
    expect(text).not.toContain("第一条");
    expect(text).toContain("助手：回复 29");
  });
});
