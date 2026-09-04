import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectTextFile, saveTextFile } from "./file-preview-service.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}

function committedRepository() {
  const directory = temporaryDirectory("file-preview-git");
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "preview@example.test");
  git(directory, "config", "user.name", "Preview Test");
  const file = join(directory, "note.txt");
  writeFileSync(file, "alpha\nbeta\n");
  git(directory, "add", "note.txt");
  git(directory, "commit", "-qm", "initial");
  return { directory, file };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe("file preview service", () => {
  it("returns full content without a patch for an unchanged tracked file", async () => {
    const { file } = committedRepository();

    const result = await inspectTextFile(file);

    expect(Buffer.from(result.data!, "base64").toString("utf8")).toBe("alpha\nbeta\n");
    expect(result.diffStatus).toBe("unchanged");
    expect(result.patch).toBe("");
    expect(result.validUtf8).toBe(true);
  });

  it("returns added and removed lines for a tracked modification", async () => {
    const { file } = committedRepository();
    writeFileSync(file, "alpha\ngamma\n");

    const result = await inspectTextFile(file);

    expect(result.diffStatus).toBe("changed");
    expect(result.patch).toContain("-beta");
    expect(result.patch).toContain("+gamma");
  });

  it("returns an all-added patch for an untracked text file", async () => {
    const { directory } = committedRepository();
    const file = join(directory, "new note.txt");
    writeFileSync(file, "first\nsecond\n");

    const result = await inspectTextFile(file);

    expect(result.diffStatus).toBe("untracked");
    expect(result.patch).toContain("+++ b/new note.txt");
    expect(result.patch).toContain("+first\n+second");
  });

  it("returns full content when no Git repository is available", async () => {
    const directory = temporaryDirectory("file-preview-plain");
    const file = join(directory, "note.txt");
    writeFileSync(file, "plain text");

    const result = await inspectTextFile(file);

    expect(result.diffStatus).toBe("unavailable");
    expect(result.patch).toBeNull();
    expect(Buffer.from(result.data!, "base64").toString("utf8")).toBe("plain text");
  });

  it("saves against the loaded version and rejects a stale save", async () => {
    const directory = temporaryDirectory("file-preview-save");
    mkdirSync(join(directory, "nested"));
    const file = join(directory, "nested", "note.txt");
    writeFileSync(file, "one");
    const loaded = await inspectTextFile(file);

    const saved = await saveTextFile(file, "two", { size: loaded.size, mtime: loaded.mtime });
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(saved.size).toBe(3);

    writeFileSync(file, "external change");
    await expect(saveTextFile(file, "three", saved)).rejects.toMatchObject({ code: "EFILECHANGED" });
    expect(readFileSync(file, "utf8")).toBe("external change");
  });
});
