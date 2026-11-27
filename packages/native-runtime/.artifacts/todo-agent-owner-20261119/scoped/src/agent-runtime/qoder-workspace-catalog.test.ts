import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QoderWorkspaceCatalog } from "./qoder-workspace-catalog.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentroam-qoder-catalog-"));
  temporary.push(root);
  await mkdir(join(root, "project-with-hyphens"));
  return { root, path: join(root, "project-with-hyphens", "native-session.jsonl"), catalog: new QoderWorkspaceCatalog(root) };
}

describe("Qoder native workspace headers", () => {
  it("uses the actual native cwd, not a guessed folder-name decode or canonical alias", async () => {
    const { path, catalog } = await fixture();
    await writeFile(path, [
      { type: "workspace-directories", directories: ["/private/tmp/my-repo"] },
      { type: "runtime-config" },
      { type: "user", cwd: "/tmp/my-repo", sessionId: "native-session", message: { content: "not retained" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await catalog.list()).toEqual(["/tmp/my-repo"]);
    expect(await catalog.list()).toEqual(["/tmp/my-repo"]);
  });

  it("falls back to native workspace metadata and ignores invalid roots", async () => {
    const { path, catalog } = await fixture();
    await writeFile(path, JSON.stringify({ type: "workspace-directories", directories: ["/repo/a", "relative", "/repo/b", 1] }) + "\n");
    expect(await catalog.list()).toEqual(["/repo/a", "/repo/b"]);
  });

  it("refreshes changed files and discovers new or removed sessions without restart", async () => {
    const { root, path, catalog } = await fixture();
    await writeFile(path, JSON.stringify({ type: "workspace-directories", directories: ["/repo/old"] }) + "\n{");
    expect(await catalog.list()).toEqual(["/repo/old"]);
    await appendFile(path, "\n" + JSON.stringify({ type: "user", cwd: "/repo/current" }) + "\n");
    const other = join(root, "project-with-hyphens", "other-session.jsonl");
    await writeFile(other, JSON.stringify({ type: "user", cwd: "/repo/new" }) + "\n");
    expect(await catalog.list()).toEqual(["/repo/current", "/repo/new"]);
    await rm(path);
    expect(await catalog.list()).toEqual(["/repo/new"]);
  });

  it("treats absent storage as empty but does not hide real storage errors", async () => {
    const { root, path } = await fixture();
    expect(await new QoderWorkspaceCatalog(join(root, "missing")).list()).toEqual([]);
    await writeFile(path, "{}");
    await expect(new QoderWorkspaceCatalog(path).list()).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
