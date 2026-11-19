import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileContextMenuActions, fileRevealMenuLabel, resolveFileForReveal } from "./file-context-menu.js";

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

  it("copies link text and the original artifact address while revealing the canonical file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam-file-menu-copy-"));
    directories.push(directory);
    const file = join(directory, "actual report.md"), link = join(directory, "artifact report.md");
    await writeFile(file, "report");
    await symlink(file, link);
    const canonical = await realpath(file);
    await expect(fileContextMenuActions(link, { label: "查看报告", line: 12 })).resolves.toEqual([
      { kind: "copy", label: "复制链接文字", value: "查看报告" },
      { kind: "copy", label: "复制路径", value: `${link}:12` },
      { kind: "reveal", label: fileRevealMenuLabel(), value: canonical },
    ]);
    await expect(fileContextMenuActions(link)).resolves.toEqual([
      { kind: "reveal", label: fileRevealMenuLabel(), value: canonical },
    ]);
  });

  it("keeps copy actions for a missing file or directory and preserves legacy reveal failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam-file-menu-missing-"));
    directories.push(directory);
    for (const path of [directory, join(directory, "missing.md")]) {
      await expect(fileContextMenuActions(path, { label: "文件内容", line: 7 })).resolves.toEqual([
        { kind: "copy", label: "复制链接文字", value: "文件内容" },
        { kind: "copy", label: "复制路径", value: `${path}:7` },
      ]);
      await expect(fileContextMenuActions(path)).rejects.toThrow();
    }
  });

  it("preserves lexical home addresses and avoids duplicate text when it equals the copied path and line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam-file-menu-label-"));
    directories.push(directory);
    const path = join(directory, "missing.md");
    await expect(fileContextMenuActions("~/missing.md", { label: "~/missing.md:23", line: 23 }, directory)).resolves.toEqual([
      { kind: "copy", label: "复制路径", value: "~/missing.md:23" },
    ]);
    await expect(fileContextMenuActions(path, { label: path })).resolves.toEqual([
      { kind: "copy", label: "复制路径", value: path },
    ]);
    await expect(fileContextMenuActions(path, { label: "  " })).resolves.toEqual([
      { kind: "copy", label: "复制路径", value: path },
    ]);
    await expect(fileContextMenuActions(path, {})).resolves.toEqual([
      { kind: "copy", label: "复制路径", value: path },
    ]);
  });

  it("copies a full Windows artifact address without interpreting it as a URL or shell command", async () => {
    const path = "C:\\AgentRoam-Missing-Artifacts\\报告 ' $(literal).md";
    await expect(fileContextMenuActions(path, { line: 19 })).resolves.toEqual([
      { kind: "copy", label: "复制路径", value: `${path}:19` },
    ]);
  });

  it.each([null, [], { label: 1 }, { label: "bad\0label" }, { line: 0 }, { line: -1 }, { line: 1.5 }, { line: NaN }, { line: Infinity }, { line: Number.MAX_SAFE_INTEGER + 1 }, { line: "12" }])("rejects malformed IPC options %j", async options => {
    await expect(fileContextMenuActions("/missing/report.md", options)).rejects.toThrow();
  });

  it.each(["relative.md", "https://example.com/report.md", "file:///tmp/report.md", "/tmp/bad\nfile", "/tmp/bad\0file"])("rejects a non-artifact copy address %j", async path => {
    await expect(fileContextMenuActions(path, {})).rejects.toThrow();
  });
});
