import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export const MAX_EDITABLE_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

function fileError(code, message) {
  return Object.assign(new Error(message), { code });
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function displayPath(value) {
  return value.replace(/[\r\n]/g, "�").replaceAll("\\", "/");
}

function untrackedPatch(relativePath, content, mode) {
  if (content.length === 0) return "";
  const shownPath = displayPath(relativePath);
  const hasFinalNewline = content.endsWith("\n");
  const body = (hasFinalNewline ? content.slice(0, -1) : content)
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  const lineCount = body ? body.split("\n").length : 0;
  const fileMode = (mode & 0o111) !== 0 ? "100755" : "100644";
  return [
    `diff --git a/${shownPath} b/${shownPath}`,
    `new file mode ${fileMode}`,
    "--- /dev/null",
    `+++ b/${shownPath}`,
    `@@ -0,0 +1,${lineCount} @@`,
    body,
    ...(hasFinalNewline ? [] : ["\\ No newline at end of file"]),
  ].join("\n");
}

async function gitDiffForFile(filePath, content, mode) {
  let root;
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], path.dirname(filePath));
    root = result.stdout.trim();
  } catch {
    return { status: "unavailable", patch: null };
  }

  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return { status: "unavailable", patch: null };
  }
  const gitPath = relativePath.split(path.sep).join("/");

  let trackedAtHead = false;
  try {
    await runGit(["cat-file", "-e", `HEAD:${gitPath}`], root);
    trackedAtHead = true;
  } catch {}

  if (!trackedAtHead) {
    const patch = untrackedPatch(gitPath, content, mode);
    return { status: patch ? "untracked" : "unchanged", patch };
  }

  try {
    const result = await runGit([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-textconv",
      "--text",
      "--unified=3",
      "HEAD",
      "--",
      gitPath,
    ], root);
    return { status: result.stdout ? "changed" : "unchanged", patch: result.stdout };
  } catch {
    return { status: "unavailable", patch: null };
  }
}

export async function inspectTextFile(filePath, maxBytes = MAX_EDITABLE_TEXT_BYTES) {
  const canonicalPath = await fsp.realpath(filePath);
  const stat = await fsp.stat(canonicalPath);
  if (!stat.isFile()) throw fileError("EISDIR", "not a regular file");
  if (stat.size > maxBytes) {
    return {
      tooLarge: true,
      data: null,
      size: stat.size,
      mtime: stat.mtimeMs,
      diffStatus: "unavailable",
      patch: null,
      validUtf8: false,
    };
  }

  const buffer = await fsp.readFile(canonicalPath);
  let text = "";
  let validUtf8 = true;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    validUtf8 = false;
    text = buffer.toString("utf8");
  }
  const diff = await gitDiffForFile(canonicalPath, text, stat.mode);
  return {
    tooLarge: false,
    data: buffer.toString("base64"),
    size: stat.size,
    mtime: stat.mtimeMs,
    diffStatus: diff.status,
    patch: diff.patch,
    validUtf8,
  };
}

export async function saveTextFile(filePath, content, expected, maxBytes = MAX_EDITABLE_TEXT_BYTES) {
  if (typeof content !== "string") throw fileError("EINVAL", "content must be a string");
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength > maxBytes) throw fileError("ETOOLARGE", "文件超过 8M，无法在预览器中保存");
  if (!expected || !Number.isFinite(expected.size) || !Number.isFinite(expected.mtime)) {
    throw fileError("EINVAL", "missing file version");
  }

  const canonicalPath = await fsp.realpath(filePath);
  const handle = await fsp.open(canonicalPath, "r+");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fileError("EISDIR", "not a regular file");
    if (stat.size !== expected.size || stat.mtimeMs !== expected.mtime) {
      throw fileError("EFILECHANGED", "文件已在其他位置更新，请重新加载后再编辑");
    }
    await handle.truncate(0);
    await handle.writeFile(buffer);
    await handle.sync();
    const updated = await handle.stat();
    return { size: updated.size, mtime: updated.mtimeMs };
  } finally {
    await handle.close();
  }
}
