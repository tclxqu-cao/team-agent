import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiledWikiPath, wikiConfig, WikiKnowledge } from "./WikiKnowledge";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "messaging-wiki-")); paths.push(root);
  await mkdir(join(root, "concepts"));
  await writeFile(join(root, "concepts/agentroam.md"), "---\ntitle: AgentRoam\n---\n# AgentRoam\n统一管理 Agent 会话，并在手机上接续任务。\n");
  await writeFile(join(root, "index.md"), "- [[concepts/agentroam]] — AgentRoam 会话管理\n");
  return root;
}
it("resolves the user's legacy wiki config without executing config values", async () => {
  const home = await fixture(); await mkdir(join(home, ".obsidian-wiki"));
  await writeFile(join(home, ".obsidian-wiki/config"), 'OBSIDIAN_VAULT_PATH="~/.obsidian/wiki"\nQMD_WIKI_COLLECTION=knowledge-base-wiki\nQMD_CLI=qmd\n');
  expect(await wikiConfig({}, home, home)).toEqual({ root: join(home, ".obsidian/wiki"), collection: "knowledge-base-wiki", command: "qmd" });
  expect(await wikiConfig({ OBSIDIAN_VAULT_PATH: "" }, home, home)).toBeNull();
});
it("retrieves compiled pages when qmd is unavailable and excludes raw archives and external symlinks", async () => {
  const root = await fixture(); const outside = await fixture();
  await symlink(join(outside, "concepts/agentroam.md"), join(root, "concepts/external.md"));
  const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([
    { file: join(root, "_raw/old.md") }, { file: join(root, "concepts/external.md") }, { file: join(outside, "concepts/agentroam.md") },
  ]) });
  const knowledge = new WikiKnowledge(async () => ({ root, command: "qmd", collection: "wiki" }), run);
  const result = await knowledge.search("AgentRoam");
  expect(result.snippets).toEqual([{ path: "concepts/agentroam.md", title: "AgentRoam", text: "# AgentRoam\n统一管理 Agent 会话，并在手机上接续任务。" }]);
  expect(result.status).toContain("1 篇");
  run.mockRejectedValueOnce(new Error("ENOENT"));
  expect((await knowledge.search("AgentRoam")).snippets).toHaveLength(1);
});
it("does not use archived, disputed or PII pages and reports missing configuration honestly", async () => {
  const root = await fixture();
  await writeFile(join(root, "concepts/agentroam.md"), "---\nvisibility: pii\n---\n# AgentRoam\nprivate\n");
  const knowledge = new WikiKnowledge(async () => ({ root, command: "qmd", collection: "" }));
  expect((await knowledge.search("AgentRoam")).snippets).toEqual([]);
  expect((await new WikiKnowledge(async () => null).search("AgentRoam")).status).toBe("知识库未配置");
  for (const path of ["../private.md", "_raw/a.md", "raw/archived/a.md", "skills/hot/example/SKILL.md", "concepts/../../secret.md"]) expect(compiledWikiPath(path)).toBe(false);
});
