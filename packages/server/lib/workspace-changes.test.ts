import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceChanges } from "./workspace-changes";

const directories: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "workspace-changes-"));
  directories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Workspace Test");
  git(root, "config", "user.email", "workspace@example.invalid");
  return root;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("workspace Git changes", () => {
  it("combines staged and unstaged changes against HEAD, preserving Chinese and tab paths", async () => {
    const root = await repository();
    const name = "计划\t变更.txt";
    await writeFile(join(root, name), "one\ntwo\n");
    await writeFile(join(root, "deleted.txt"), "gone\n");
    git(root, "add", "."); git(root, "commit", "-m", "initial");
    await writeFile(join(root, name), "one\nupdated\n");
    git(root, "add", name);
    await writeFile(join(root, name), "one\nupdated\nthree\n");
    await rm(join(root, "deleted.txt"));
    await writeFile(join(root, "new.txt"), "not counted as tracked text\n");
    const result = await readWorkspaceChanges(root, resolve);
    expect(result.branch).toBe("main");
    expect(result.files).toContainEqual({ path: name, status: "modified", added: 2, removed: 1 });
    expect(result.files).toContainEqual({ path: "deleted.txt", status: "deleted", added: 0, removed: 1 });
    expect(result.files).toContainEqual({ path: "new.txt", status: "untracked", added: null, removed: null });
  });

  it("keeps binary counts unknown and reports a clean repository", async () => {
    const root = await repository();
    await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2]));
    git(root, "add", "."); git(root, "commit", "-m", "initial");
    expect((await readWorkspaceChanges(root, resolve)).files).toEqual([]);
    await writeFile(join(root, "image.bin"), Buffer.from([0, 3, 4]));
    expect((await readWorkspaceChanges(root, resolve)).files).toEqual([
      { path: "image.bin", status: "modified", added: null, removed: null },
    ]);
  });

  it("handles an unborn branch and ordinary directories", async () => {
    const root = await repository();
    await writeFile(join(root, "first.txt"), "first\n");
    git(root, "add", ".");
    expect((await readWorkspaceChanges(root, resolve)).files[0].status).toBe("added");
    const plain = await mkdtemp(join(tmpdir(), "workspace-plain-"));
    directories.push(plain);
    expect(await readWorkspaceChanges(plain, resolve)).toEqual({ repository: false, root: null, branch: null, files: [] });
  });

  it("validates the discovered repository root before reading outside an allowed subdirectory", async () => {
    const root = await repository();
    const subdirectory = join(root, "allowed");
    await mkdir(subdirectory);
    const allow = (path: string) => {
      if (resolve(path) !== resolve(subdirectory)) throw new Error("Outside allowed root");
      return path;
    };
    await expect(readWorkspaceChanges(subdirectory, allow)).rejects.toThrow("Outside allowed root");
  });
});
