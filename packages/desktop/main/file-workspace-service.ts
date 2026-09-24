import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch as watchFs, type FSWatcher } from "node:fs";
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Marked } from "marked";
import {
  HostPathPolicy,
  type FileWorkspaceDiffStatus,
  type FileWorkspaceEntry,
  type FileWorkspaceEvent,
  type FileWorkspaceMethod,
  type FileWorkspacePreviewTicket,
  type FileWorkspaceReadResult,
  type FileWorkspaceTextInspection,
  type FileWorkspaceTextStatus,
} from "@agent/core";

const MAX_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_EDITABLE_TEXT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_TICKETS = 256;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".css": "text/css",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
};

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkdn", ".mdx"]);

interface PreviewTicketState {
  path: string;
  mime: string;
  markdown: boolean;
  expiresAt: number;
}

export interface DesktopFileWorkspaceServiceOptions {
  roots: string[];
  home?: string;
  emit: (event: FileWorkspaceEvent) => void;
  now?: () => number;
  token?: () => string;
  ticketTtlMs?: number;
}

function workspaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function requiredPath(params: Record<string, unknown>): string {
  if (typeof params.path !== "string" || !params.path.trim()) {
    throw workspaceError("PATH_REQUIRED", "路径不能为空");
  }
  return params.path;
}

function mimeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function execGit(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolveResult) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolveResult({
        stdout: stdout ?? "",
        code: typeof error?.code === "number" ? error.code : error ? 2 : 0,
      }),
    );
  });
}

async function gitRoot(filePath: string): Promise<string | null> {
  const result = await execGit(["rev-parse", "--show-toplevel"], dirname(filePath));
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

async function gitFileState(filePath: string, includePatch: boolean): Promise<{
  status: FileWorkspaceDiffStatus;
  patch: string | null;
}> {
  const root = await gitRoot(filePath);
  if (!root) return { status: "unavailable", patch: null };
  const rel = relative(root, filePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return { status: "unavailable", patch: null };
  const gitPath = rel.split(sep).join("/");
  const tracked = await execGit(["cat-file", "-e", `HEAD:${gitPath}`], root);
  if (tracked.code !== 0) {
    if (!includePatch) return { status: "untracked", patch: null };
    const patch = await execGit(["diff", "--no-index", "--no-color", "--", "/dev/null", gitPath], root);
    return { status: "untracked", patch: patch.stdout || null };
  }
  const diff = await execGit(["diff", "--no-ext-diff", "--no-color", "--text", "--unified=3", "HEAD", "--", gitPath], root);
  if (diff.code > 1) return { status: "unavailable", patch: null };
  return { status: diff.stdout ? "changed" : "unchanged", patch: includePatch ? diff.stdout || null : null };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderDesktopMarkdown(source: string, title: string): string {
  const body = markdown.parse(source, { async: false });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText;line-height:1.65;overflow-wrap:anywhere}main{width:min(100% - 32px,860px);margin:0 auto;padding:28px 0 52px}h1,h2,h3,h4,h5,h6{margin:1.45em 0 .55em;line-height:1.25}h1{margin-top:0;padding-bottom:.35em;border-bottom:1px solid color-mix(in srgb,CanvasText 18%,transparent)}h2{padding-bottom:.3em;border-bottom:1px solid color-mix(in srgb,CanvasText 13%,transparent)}p,ul,ol,blockquote,table,pre{margin:0 0 1em}ul,ol{padding-left:1.7em}blockquote{margin-left:0;padding:.15em 1em;border-left:4px solid #7aa2f7}img,video{display:block;max-width:100%;height:auto;margin:1em auto}pre{max-width:100%;overflow:auto;padding:14px 16px;border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:6px;background:color-mix(in srgb,CanvasText 7%,Canvas)}code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.9em}table{display:block;width:max-content;max-width:100%;overflow-x:auto;border-spacing:0;border-collapse:collapse}th,td{padding:7px 12px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);text-align:left}</style></head><body><main>${body}</main></body></html>`;
}

export class DesktopFileWorkspaceService {
  private readonly policy: HostPathPolicy;
  private readonly home: string;
  private readonly emit: (event: FileWorkspaceEvent) => void;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly ticketTtlMs: number;
  private readonly tickets = new Map<string, PreviewTicketState>();
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(options: DesktopFileWorkspaceServiceOptions) {
    this.policy = new HostPathPolicy(options.roots);
    this.home = this.policy.assertDirectory(options.home ?? this.policy.roots[0]);
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.token = options.token ?? (() => randomBytes(24).toString("base64url"));
    this.ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  }

  async request(method: FileWorkspaceMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case "hello":
        return { home: this.home };
      case "fs:list":
        return { entries: await this.list(requiredPath(params)) };
      case "fs:read":
        return this.read(requiredPath(params), params.offset, params.length);
      case "fs:stat":
        return this.fileStat(requiredPath(params));
      case "fs:inspect-text-status":
        return this.inspectTextStatus(requiredPath(params));
      case "fs:inspect-text":
        return this.inspectText(requiredPath(params));
      case "fs:write-text":
        return this.writeText(requiredPath(params), params);
      case "fs:watch":
        return this.watch(requiredPath(params));
      case "fs:unwatch":
        return this.unwatch(requiredPath(params));
      case "fs:preview-open":
        return this.openPreview(requiredPath(params));
      case "fs:preview-close":
        return { revoked: this.revokePreview(String(params.ticketId ?? "")) };
      default:
        throw workspaceError("UNSUPPORTED_METHOD", `不支持的文件操作：${method}`);
    }
  }

  resolvePreviewTicket(ticketId: string): PreviewTicketState | null {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return null;
    if (ticket.expiresAt <= this.now()) {
      this.tickets.delete(ticketId);
      return null;
    }
    return { ...ticket };
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.tickets.clear();
  }

  private async list(inputPath: string): Promise<FileWorkspaceEntry[]> {
    const directory = this.policy.assertDirectory(inputPath);
    const dirents = await readdir(directory, { withFileTypes: true });
    const entries = await Promise.all(dirents.map(async (dirent): Promise<FileWorkspaceEntry | null> => {
      const displayed = join(directory, dirent.name);
      try {
        const link = await lstat(displayed);
        const canonical = this.policy.assertAllowed(displayed);
        const info = await stat(canonical);
        if (!info.isDirectory() && !info.isFile()) return null;
        return {
          name: dirent.name,
          dir: info.isDirectory(),
          symlink: link.isSymbolicLink(),
          size: info.size,
          mtime: info.mtimeMs,
        };
      } catch {
        return null;
      }
    }));
    return entries
      .filter((entry): entry is FileWorkspaceEntry => entry !== null)
      .sort((left, right) => Number(right.dir) - Number(left.dir) || left.name.localeCompare(right.name));
  }

  private async read(inputPath: string, rawOffset: unknown, rawLength: unknown): Promise<FileWorkspaceReadResult> {
    const filePath = this.policy.assertAllowed(inputPath);
    const info = await stat(filePath);
    if (!info.isFile()) throw workspaceError("EISDIR", "只能读取普通文件");
    const offset = Number.isSafeInteger(rawOffset) && Number(rawOffset) >= 0 ? Number(rawOffset) : 0;
    const requested = Number.isSafeInteger(rawLength) && Number(rawLength) > 0 ? Number(rawLength) : 256 * 1024;
    const length = Math.min(requested, MAX_READ_CHUNK_BYTES, Math.max(0, info.size - offset));
    const buffer = Buffer.alloc(length);
    const handle = await open(filePath, "r");
    try {
      const { bytesRead } = length ? await handle.read(buffer, 0, length, offset) : { bytesRead: 0 };
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        bytes: bytesRead,
        offset,
        eof: offset + bytesRead >= info.size,
        size: info.size,
      };
    } finally {
      await handle.close();
    }
  }

  private async fileStat(inputPath: string): Promise<{ size: number; mtime: number; dir: boolean }> {
    const filePath = this.policy.assertAllowed(inputPath);
    const info = await stat(filePath);
    return { size: info.size, mtime: info.mtimeMs, dir: info.isDirectory() };
  }

  private async inspectTextStatus(inputPath: string): Promise<FileWorkspaceTextStatus> {
    const filePath = this.policy.assertAllowed(inputPath);
    const info = await stat(filePath);
    if (!info.isFile()) throw workspaceError("EISDIR", "只能检查普通文件");
    return {
      tooLarge: info.size > MAX_EDITABLE_TEXT_BYTES,
      size: info.size,
      mtime: info.mtimeMs,
      diffStatus: (await gitFileState(filePath, false)).status,
    };
  }

  private async inspectText(inputPath: string): Promise<FileWorkspaceTextInspection> {
    const filePath = this.policy.assertAllowed(inputPath);
    const info = await stat(filePath);
    if (!info.isFile()) throw workspaceError("EISDIR", "只能检查普通文件");
    if (info.size > MAX_EDITABLE_TEXT_BYTES) {
      return { tooLarge: true, data: null, size: info.size, mtime: info.mtimeMs, diffStatus: "unavailable", patch: null, validUtf8: false };
    }
    const buffer = await readFile(filePath);
    let validUtf8 = true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      validUtf8 = false;
    }
    const diff = await gitFileState(filePath, true);
    return {
      tooLarge: false,
      data: buffer.toString("base64"),
      size: info.size,
      mtime: info.mtimeMs,
      diffStatus: diff.status,
      patch: diff.patch,
      validUtf8,
    };
  }

  private async writeText(inputPath: string, params: Record<string, unknown>): Promise<{ size: number; mtime: number }> {
    if (typeof params.content !== "string") throw workspaceError("EINVAL", "文件内容必须是文本");
    const content = Buffer.from(params.content, "utf8");
    if (content.byteLength > MAX_EDITABLE_TEXT_BYTES) throw workspaceError("ETOOLARGE", "文件超过 8M，无法在预览器中保存");
    if (!Number.isFinite(params.expectedSize) || !Number.isFinite(params.expectedMtime)) {
      throw workspaceError("EINVAL", "缺少文件版本信息");
    }
    const filePath = this.policy.assertAllowed(inputPath);
    const handle = await open(filePath, "r+");
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw workspaceError("EISDIR", "只能保存普通文件");
      if (before.size !== params.expectedSize || before.mtimeMs !== params.expectedMtime) {
        throw workspaceError("EFILECHANGED", "文件已在其他位置更新，请重新加载后再编辑");
      }
      await handle.truncate(0);
      await handle.writeFile(content);
      await handle.sync();
      const after = await handle.stat();
      return { size: after.size, mtime: after.mtimeMs };
    } finally {
      await handle.close();
    }
  }

  private watch(inputPath: string): { watching: true; path: string } {
    const watchedPath = this.policy.assertAllowed(inputPath);
    if (!this.watchers.has(watchedPath)) {
      const watcher = watchFs(watchedPath, { persistent: false }, (type, fileName) => {
        const changedPath = fileName ? resolve(watchedPath, fileName.toString()) : watchedPath;
        try {
          this.emit({ path: changedPath, type });
        } catch {}
      });
      watcher.on("error", () => this.unwatchCanonical(watchedPath));
      this.watchers.set(watchedPath, watcher);
    }
    return { watching: true, path: watchedPath };
  }

  private unwatch(inputPath: string): { watching: false; path: string } {
    const watchedPath = this.policy.assertAllowed(inputPath);
    this.unwatchCanonical(watchedPath);
    return { watching: false, path: watchedPath };
  }

  private unwatchCanonical(path: string): void {
    this.watchers.get(path)?.close();
    this.watchers.delete(path);
  }

  private async openPreview(inputPath: string): Promise<FileWorkspacePreviewTicket> {
    const filePath = this.policy.assertAllowed(inputPath);
    const info = await stat(filePath);
    if (!info.isFile()) throw workspaceError("EISDIR", "只能预览普通文件");
    this.pruneTickets();
    const ticketId = this.token();
    const extension = extname(filePath).toLowerCase();
    const mime = mimeFor(filePath);
    this.tickets.set(ticketId, {
      path: filePath,
      mime,
      markdown: MARKDOWN_EXTENSIONS.has(extension),
      expiresAt: this.now() + this.ticketTtlMs,
    });
    return {
      ticketId,
      url: `agentroam-preview://${ticketId}`,
      size: info.size,
      mtime: info.mtimeMs,
      mime,
    };
  }

  private revokePreview(ticketId: string): boolean {
    return this.tickets.delete(ticketId);
  }

  private pruneTickets(): void {
    const now = this.now();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(id);
    }
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
  }
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) throw workspaceError("EINVALIDRANGE", "无效的文件范围");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw workspaceError("EINVALIDRANGE", "无效的文件范围");
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    throw workspaceError("EINVALIDRANGE", "无效的文件范围");
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function createDesktopPreviewResponse(
  service: DesktopFileWorkspaceService,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const ticket = service.resolvePreviewTicket(url.hostname);
  if (!ticket) return new Response("Preview ticket expired", { status: 404 });
  const info = await stat(ticket.path);
  if (ticket.markdown) {
    if (info.size > MAX_EDITABLE_TEXT_BYTES) return new Response("Markdown file is too large", { status: 413 });
    const document = renderDesktopMarkdown(await readFile(ticket.path, "utf8"), basename(ticket.path));
    return new Response(request.method === "HEAD" ? null : document, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "x-content-type-options": "nosniff",
      },
    });
  }

  let range: { start: number; end: number } | null;
  try {
    range = parseRange(request.headers.get("range"), info.size);
  } catch {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${info.size}`, "accept-ranges": "bytes" },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, info.size - 1);
  const length = info.size === 0 ? 0 : end - start + 1;
  const buffer = Buffer.alloc(length);
  if (length) {
    const handle = await open(ticket.path, "r");
    try {
      await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
  }
  return new Response(request.method === "HEAD" ? null : buffer, {
    status: range ? 206 : 200,
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-length": String(length),
      "content-type": ticket.mime,
      "content-security-policy": ticket.mime.startsWith("text/html")
        ? "sandbox allow-scripts allow-popups allow-forms allow-modals"
        : "default-src 'none'",
      ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
      "x-content-type-options": "nosniff",
    },
  });
}
