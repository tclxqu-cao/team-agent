import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface FileContextMenuOptions { label?: string; line?: number }
export interface FileContextMenuAction { kind: "copy" | "reveal"; label: string; value: string }

/** Copy the artifact address as written, independently of a file's existence or
 * symlink target. A path from another OS can still be copied on this device. */
function filePathForCopy(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) throw new Error("文件路径无效");
  if (!value.startsWith("~/") && !isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) {
    throw new Error("只能复制绝对文件路径");
  }
  return value;
}

/** Keep legacy reveal-only callers unchanged. Artifact links opt into copying;
 * an unavailable local file manager target must not remove those copy actions. */
export async function fileContextMenuActions(value: unknown, options?: unknown, home = homedir()): Promise<FileContextMenuAction[]> {
  if (options === undefined) return [{ kind: "reveal", label: fileRevealMenuLabel(), value: await resolveFileForReveal(value, home) }];
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("文件菜单选项无效");
  const { label, line } = options as Record<string, unknown>;
  if (label !== undefined && (typeof label !== "string" || label.includes("\0"))) throw new Error("链接文字无效");
  if (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)) throw new Error("文件行号无效");
  const path = filePathForCopy(value);
  const address = line === undefined ? path : `${path}:${line}`;
  const actions: FileContextMenuAction[] = [];
  if (typeof label === "string" && label.trim() && label !== address) actions.push({ kind: "copy", label: "复制链接文字", value: label });
  actions.push({ kind: "copy", label: "复制路径", value: address });
  try { actions.push({ kind: "reveal", label: fileRevealMenuLabel(), value: await resolveFileForReveal(value, home) }); }
  catch { /* Missing files, directories and foreign paths still support copying. */ }
  return actions;
}

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
