import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileRevealMenuLabel, resolveFileForReveal } from "./file-context-menu.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("artifact file context menu", () => {
  it("resolves existing files including spaces, home paths, and symbolic links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam-file-menu-"));
    directories.push(directory);
    const file = join(directory, "Word 优化版.docx");
    await writeFile(file, "report");
    const link = join(directory, "report.docx");
    await symlink(file, link);
    const canonicalFile = await realpath(file);

    await expect(resolveFileForReveal(file)).resolves.toBe(canonicalFile);
    await expect(resolveFileForReveal("~/Word 优化版.docx", directory)).resolves.toBe(canonicalFile);
    await expect(resolveFileForReveal(link)).resolves.toBe(canonicalFile);
    await expect(resolveFileForReveal(directory)).rejects.toThrow("目标不是文件");
    await expect(resolveFileForReveal(join(directory, "missing.docx"))).rejects.toThrow("文件不存在或无法访问");
  });

  it.each([null, "", "relative.docx", "https://example.com/report.docx", "file:///tmp/report.docx", "/tmp/bad\nfile", "/tmp/bad\0file"])("rejects invalid or non-local target %j", async (value) => {
    await expect(resolveFileForReveal(value)).rejects.toThrow();
  });

  it("labels the native action for each platform", () => {
    expect(fileRevealMenuLabel("darwin")).toBe("在 Finder 中显示");
    expect(fileRevealMenuLabel("win32")).toBe("在文件资源管理器中显示");
    expect(fileRevealMenuLabel("linux")).toBe("在文件管理器中显示");
  });
});
