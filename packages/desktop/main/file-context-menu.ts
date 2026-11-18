import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Resolve a user-selected artifact before handing it to the native file manager. */
export async function resolveFileForReveal(value: unknown, home = homedir()): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error("文件路径无效");
  }
  const path = value.startsWith("~/") ? resolve(home, value.slice(2)) : value;
  if (!isAbsolute(path)) throw new Error("只能定位本机绝对文件路径");

  try {
    const file = await realpath(path);
    if (!(await stat(file)).isFile()) throw new Error("目标不是文件");
    return file;
  } catch (error) {
    if (error instanceof Error && error.message === "目标不是文件") throw error;
    throw new Error("文件不存在或无法访问");
  }
}

export function fileRevealMenuLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "在 Finder 中显示";
  if (platform === "win32") return "在文件资源管理器中显示";
  return "在文件管理器中显示";
}
