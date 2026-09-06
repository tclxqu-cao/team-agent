import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  MAX_MARKDOWN_PREVIEW_BYTES,
  renderMarkdownPreviewDocument,
} from "./markdown-preview.mjs";

export const MAX_EDITABLE_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_PREVIEW_TICKET_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PREVIEW_TICKETS = 256;

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

function runGitForExitCode(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=false", ...args], { cwd }, (error) => {
      resolve(typeof error?.code === "number" ? error.code : error ? 2 : 0);
    });
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

async function gitStatusForFile(filePath) {
  let root;
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], path.dirname(filePath));
    root = result.stdout.trim();
  } catch {
    return "unavailable";
  }

  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return "unavailable";
  }
  const gitPath = relativePath.split(path.sep).join("/");
  try {
    await runGit(["cat-file", "-e", `HEAD:${gitPath}`], root);
  } catch {
    return "untracked";
  }

  const exitCode = await runGitForExitCode(["diff", "--quiet", "HEAD", "--", gitPath], root);
  if (exitCode === 0) return "unchanged";
  if (exitCode === 1) return "changed";
  return "unavailable";
}

export async function inspectTextFileStatus(filePath, maxBytes = MAX_EDITABLE_TEXT_BYTES) {
  const canonicalPath = await fsp.realpath(filePath);
  const stat = await fsp.stat(canonicalPath);
  if (!stat.isFile()) throw fileError("EISDIR", "not a regular file");
  return {
    size: stat.size,
    mtime: stat.mtimeMs,
    tooLarge: stat.size > maxBytes,
    diffStatus: await gitStatusForFile(canonicalPath),
  };
}

export function parsePreviewRange(header, size) {
  if (!header) return null;
  if (!Number.isSafeInteger(size) || size < 0 || !header.startsWith("bytes=") || header.includes(",")) {
    throw fileError("EINVALIDRANGE", "invalid byte range");
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) {
    throw fileError("EINVALIDRANGE", "invalid byte range");
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw fileError("EINVALIDRANGE", "invalid byte range");
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw fileError("EINVALIDRANGE", "invalid byte range");
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function servePreviewFile(request, response, filePath, mime = "application/octet-stream", extraHeaders = {}) {
  const canonicalPath = await fsp.realpath(filePath);
  const stat = await fsp.stat(canonicalPath);
  if (!stat.isFile()) throw fileError("EISDIR", "not a regular file");

  let range;
  try {
    range = parsePreviewRange(request.headers.range, stat.size);
  } catch (error) {
    if (error?.code !== "EINVALIDRANGE") throw error;
    response.writeHead(416, {
      "accept-ranges": "bytes",
      "content-range": `bytes */${stat.size}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stat.size - 1);
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-length": String(stat.size === 0 ? 0 : end - start + 1),
    "content-type": mime,
    "x-content-type-options": "nosniff",
    ...extraHeaders,
    ...(range ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {}),
  };
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD" || stat.size === 0) {
    response.end();
    return;
  }

  const stream = createReadStream(canonicalPath, { start, end });
  stream.on("error", (error) => response.destroy(error));
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

export async function serveMarkdownPreview(request, response, filePath, extraHeaders = {}) {
  const canonicalPath = await fsp.realpath(filePath);
  const stat = await fsp.stat(canonicalPath);
  if (!stat.isFile()) throw fileError("EISDIR", "not a regular file");

  const oversized = stat.size > MAX_MARKDOWN_PREVIEW_BYTES;
  const source = oversized
    ? "# 无法渲染此 Markdown\n\n文件超过 8 MiB，请退出眼睛预览后使用渐进式源码视图阅读。"
    : await fsp.readFile(canonicalPath, "utf8");
  const document = renderMarkdownPreviewDocument(source, { title: path.basename(canonicalPath) });
  const length = Buffer.byteLength(document);
  response.writeHead(oversized ? 413 : 200, {
    "cache-control": "private, no-store",
    "content-length": String(length),
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(document);
}

export function createPreviewTicketRegistry({
  ttlMs = DEFAULT_PREVIEW_TICKET_TTL_MS,
  maxTickets = DEFAULT_MAX_PREVIEW_TICKETS,
  now = () => Date.now(),
  token = () => randomBytes(24).toString("base64url"),
} = {}) {
  const tickets = new Map();
  const prune = () => {
    const current = now();
    for (const [id, ticket] of tickets) {
      if (current - ticket.lastAccessAt >= ttlMs) tickets.delete(id);
    }
    while (tickets.size >= maxTickets) tickets.delete(tickets.keys().next().value);
  };
  return {
    issue(filePath, userId) {
      prune();
      const id = token();
      tickets.set(id, { path: filePath, userId, lastAccessAt: now() });
      return id;
    },
    resolve(id) {
      const ticket = tickets.get(id);
      if (!ticket) return null;
      const current = now();
      if (current - ticket.lastAccessAt >= ttlMs) {
        tickets.delete(id);
        return null;
      }
      ticket.lastAccessAt = current;
      return { ...ticket };
    },
    revoke(id, userId) {
      const ticket = tickets.get(id);
      if (!ticket || ticket.userId !== userId) return false;
      return tickets.delete(id);
    },
  };
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
