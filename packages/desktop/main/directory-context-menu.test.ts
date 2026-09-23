import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directoryOpenMenuLabel,
  revealDirectoryWithShell,
  resolveDirectoryForOpen,
} from "./directory-context-menu.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("desktop directory context menu", () => {
  it("accepts only an existing absolute directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam-directory-menu-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "file.txt");
    await writeFile(file, "content");

    await expect(resolveDirectoryForOpen(directory)).resolves.toBe(await realpath(directory));
    await expect(resolveDirectoryForOpen(file)).rejects.toThrow("目标不是文件夹");
    await expect(resolveDirectoryForOpen("relative/path")).rejects.toThrow("只能打开本机绝对目录");
    await expect(resolveDirectoryForOpen(join(directory, "missing"))).rejects.toThrow("目录不存在或无法访问");
    await expect(resolveDirectoryForOpen(null)).rejects.toThrow("目录路径无效");
  });

  it("uses the native file-manager label for each desktop platform", () => {
    expect(directoryOpenMenuLabel("darwin")).toBe("在 Finder 中打开");
    expect(directoryOpenMenuLabel("win32")).toBe("在文件资源管理器中打开");
    expect(directoryOpenMenuLabel("linux")).toBe("打开当前文件夹");
  });

  it("reveals the validated directory through the native file manager", () => {
    const reveal = vi.fn();
    revealDirectoryWithShell("/workspace", reveal);
    expect(reveal).toHaveBeenCalledWith("/workspace");
  });
});
