import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
export async function resolveDirectoryForOpen(value) {
    if (typeof value !== "string" || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
        throw new Error("目录路径无效");
    }
    if (!isAbsolute(value)) {
        throw new Error("只能打开本机绝对目录");
    }
    let directory;
    try {
        directory = await realpath(value);
    }
    catch {
        throw new Error("目录不存在或无法访问");
    }
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) {
        throw new Error("目标不是文件夹");
    }
    return directory;
}
export function directoryOpenMenuLabel(platform = process.platform) {
    if (platform === "darwin")
        return "在 Finder 中打开";
    if (platform === "win32")
        return "在文件资源管理器中打开";
    return "打开当前文件夹";
}
export function revealDirectoryWithShell(directory, reveal) {
    reveal(directory);
}
//# sourceMappingURL=directory-context-menu.js.map