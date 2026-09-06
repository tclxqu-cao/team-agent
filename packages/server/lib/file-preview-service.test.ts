import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPreviewTicketRegistry,
  inspectTextFile,
  inspectTextFileStatus,
  parsePreviewRange,
  saveTextFile,
  servePreviewFile,
} from "./file-preview-service.mjs";

const temporaryDirectories: string[] = [];
const wsServerSource = readFileSync(new URL("../ws-server.mjs", import.meta.url), "utf8");

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

  it("reports Git status without returning full file data", async () => {
    const { file } = committedRepository();
    writeFileSync(file, "alpha\ngamma\n");

    const result = await inspectTextFileStatus(file);

    expect(result).toMatchObject({
      size: Buffer.byteLength("alpha\ngamma\n"),
      tooLarge: false,
      diffStatus: "changed",
    });
    expect(result).not.toHaveProperty("data");
    expect(result).not.toHaveProperty("patch");
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

describe("file preview ranges", () => {
  it.each([
    [undefined, null],
    ["bytes=2-5", { start: 2, end: 5 }],
    ["bytes=6-", { start: 6, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }],
    ["bytes=8-20", { start: 8, end: 9 }],
  ])("parses %s", (header, expected) => {
    expect(parsePreviewRange(header, 10)).toEqual(expected);
  });

  it.each(["items=0-2", "bytes=", "bytes=5-3", "bytes=20-", "bytes=0-1,4-5"])("rejects %s", (header) => {
    expect(() => parsePreviewRange(header, 10)).toThrow("invalid byte range");
  });
});

function createMockPreviewResponse() {
  const state: { statusCode: number; headers: Record<string, string> | null } = { statusCode: 0, headers: null };
  const chunks: Buffer[] = [];
  const response = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  (response as unknown as { writeHead: (status: number, headers?: Record<string, string>) => unknown }).writeHead = (status, headers) => {
    state.statusCode = status;
    state.headers = headers ?? null;
    return response;
  };
  return { response, state, chunks };
}

describe("file preview ticket registry", () => {
  it("refreshes valid tickets and enforces ownership during revocation", () => {
    let current = 1_000;
    let sequence = 0;
    const registry = createPreviewTicketRegistry({
      ttlMs: 100,
      now: () => current,
      token: () => `ticket-${++sequence}`,
    });

    const id = registry.issue("/tmp/report.pdf", "user-a");
    current = 1_050;
    expect(registry.resolve(id)).toMatchObject({ path: "/tmp/report.pdf", userId: "user-a" });
    expect(registry.revoke(id, "user-b")).toBe(false);
    expect(registry.revoke(id, "user-a")).toBe(true);
    expect(registry.resolve(id)).toBeNull();
  });

  it("expires idle tickets", () => {
    let current = 1_000;
    const registry = createPreviewTicketRegistry({ ttlMs: 100, now: () => current, token: () => "ticket" });
    registry.issue("/tmp/report.pdf", "user-a");
    current = 1_100;
    expect(registry.resolve("ticket")).toBeNull();
  });
});

describe("html deliverable preview", () => {
  it("streams the file with extra response headers such as the html sandbox CSP", async () => {
    const directory = temporaryDirectory("preview-extra-headers");
    const file = join(directory, "page.html");
    writeFileSync(file, "<!doctype html><p>hello preview</p>");
    const { response, state, chunks } = createMockPreviewResponse();

    await servePreviewFile(
      { headers: {} } as never,
      response as never,
      file,
      "text/html; charset=utf-8",
      { "content-security-policy": "sandbox allow-scripts allow-popups allow-forms allow-modals" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(state.statusCode).toBe(200);
    expect(state.headers?.["content-type"]).toBe("text/html; charset=utf-8");
    expect(state.headers?.["content-security-policy"]).toBe("sandbox allow-scripts allow-popups allow-forms allow-modals");
    expect(state.headers?.["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.concat(chunks).toString("utf8")).toContain("hello preview");
  });
});

describe("file preview gateway authorization contract", () => {
  it("authorizes both ticket issuance and every ticketed HTTP open", () => {
    const issuance = wsServerSource.slice(
      wsServerSource.indexOf('"fs:preview-open"'),
      wsServerSource.indexOf('"fs:preview-close"'),
    );
    const serving = wsServerSource.slice(
      wsServerSource.indexOf("async function serveTicketedFilePreview"),
      wsServerSource.indexOf("const server = createServer"),
    );

    expect(issuance).toContain("assertAllowed(msg.path, conn.principal.userId)");
    expect(serving).toContain("assertAllowed(ticket.path, ticket.userId)");
    const serverCallback = wsServerSource.slice(wsServerSource.indexOf("const server = createServer"));
    expect(serverCallback.indexOf("serveTicketedFilePreview(req, res)")).toBeLessThan(
      serverCallback.indexOf("serveWebApp(req, res)"),
    );
  });
});

describe("browser preview gateway contract", () => {
  const serving = () =>
    wsServerSource.slice(
      wsServerSource.indexOf("async function serveTicketedFilePreview"),
      wsServerSource.indexOf("const server = createServer"),
    );

  it("serves browser-readable text formats with inline mime types", () => {
    const mimeMap = wsServerSource.slice(
      wsServerSource.indexOf("const MIME_BY_EXT"),
      wsServerSource.indexOf("function mimeFor"),
    );
    expect(mimeMap).toContain('html: "text/html; charset=utf-8"');
    expect(mimeMap).toContain('htm: "text/html; charset=utf-8"');
    expect(mimeMap).toContain('css: "text/css; charset=utf-8"');
    expect(mimeMap).toContain('md: "text/markdown; charset=utf-8"');
    expect(mimeMap).toContain('markdown: "text/markdown; charset=utf-8"');
    expect(mimeMap).toContain('json: "application/json; charset=utf-8"');
    expect(mimeMap).toContain('xml: "application/xml; charset=utf-8"');
    expect(wsServerSource).toContain('PLAIN_TEXT_EXTS.has(ext) ? "text/plain; charset=utf-8"');
  });

  it("confines rendered html to an opaque origin sandbox", () => {
    expect(wsServerSource).toContain('const HTML_PREVIEW_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals"');
    expect(serving()).toContain('mimeFor(target).startsWith("text/html")');
    expect(serving()).toContain('"content-security-policy": HTML_PREVIEW_CSP');
  });

  it("renders only the primary Markdown document with a script-free CSP", () => {
    expect(wsServerSource).toContain("const MARKDOWN_PREVIEW_CSP = [");
    expect(wsServerSource).toContain('"sandbox allow-popups allow-forms"');
    expect(wsServerSource).toContain('"default-src \'none\'"');
    expect(serving()).toContain("relativeSegments.length > 0 && target === primary && isMarkdownPreviewPath(primary)");
    expect(serving()).toContain('serveMarkdownPreview(req, res, primary, { "content-security-policy": MARKDOWN_PREVIEW_CSP })');
  });

  it("resolves relative resources against the deliverable directory through authorization", () => {
    expect(serving()).toContain("relativeSegments");
    expect(serving()).toContain("path.resolve(path.dirname(primary), relative)");
    expect(serving()).toContain("assertAllowed(path.resolve(path.dirname(primary), relative), ticket.userId)");
  });
});
