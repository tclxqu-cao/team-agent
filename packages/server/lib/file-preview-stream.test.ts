import { createServer, request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MARKDOWN_PREVIEW_BYTES } from "./markdown-preview.mjs";
import { serveMarkdownPreview, servePreviewFile } from "./file-preview-service.mjs";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fetchPreview(range?: string, method = "GET", content = "0123456789") {
  const directory = mkdtempSync(join(tmpdir(), "file-preview-stream-"));
  directories.push(directory);
  const file = join(directory, "sample.txt");
  writeFileSync(file, content);
  const server = createServer((req, res) => {
    void servePreviewFile(req, res, file, "text/plain").catch((error) => {
      res.writeHead(500).end(error.message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const responseHeaders: Record<string, string | string[] | undefined> = {};
      const req = request({ hostname: "127.0.0.1", port: address.port, method, headers: range ? { range } : {} }, (res) => {
        Object.assign(responseHeaders, res.headers);
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body }));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("servePreviewFile", () => {
  it("rejects directories before writing response headers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "file-preview-directory-"));
    directories.push(directory);

    await expect(servePreviewFile(
      { headers: {}, method: "GET" } as any,
      {} as any,
      directory,
      "application/octet-stream",
    )).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("streams a full file with private range-aware headers", async () => {
    const result = await fetchPreview();
    expect(result.status).toBe(200);
    expect(result.body).toBe("0123456789");
    expect(result.headers["accept-ranges"]).toBe("bytes");
    expect(result.headers["content-length"]).toBe("10");
    expect(result.headers["cache-control"]).toBe("private, no-store");
  });

  it("streams one byte range", async () => {
    const result = await fetchPreview("bytes=2-5");
    expect(result.status).toBe(206);
    expect(result.body).toBe("2345");
    expect(result.headers["content-range"]).toBe("bytes 2-5/10");
    expect(result.headers["content-length"]).toBe("4");
  });

  it.each([
    ["bytes=6-", "6789", "bytes 6-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ])("streams %s", async (range, body, contentRange) => {
    const result = await fetchPreview(range);
    expect(result.status).toBe(206);
    expect(result.body).toBe(body);
    expect(result.headers["content-range"]).toBe(contentRange);
  });

  it("supports HEAD without a body", async () => {
    const result = await fetchPreview(undefined, "HEAD");
    expect(result.status).toBe(200);
    expect(result.body).toBe("");
    expect(result.headers["content-length"]).toBe("10");
  });

  it("returns 416 for an invalid range", async () => {
    const result = await fetchPreview("bytes=20-");
    expect(result.status).toBe(416);
    expect(result.headers["content-range"]).toBe("bytes */10");
  });

  it("serves empty files without opening an invalid stream range", async () => {
    const result = await fetchPreview(undefined, "GET", "");
    expect(result.status).toBe(200);
    expect(result.body).toBe("");
    expect(result.headers["content-length"]).toBe("0");
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("serveMarkdownPreview", () => {
  async function fetchMarkdown(method = "GET", content = "# Rendered") {
    const directory = mkdtempSync(join(tmpdir(), "markdown-preview-stream-"));
    directories.push(directory);
    const file = join(directory, "README.md");
    writeFileSync(file, content);
    const server = createServer((req, res) => {
      void serveMarkdownPreview(req, res, file, {
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      }).catch((error) => {
        res.writeHead(500).end(error.message);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");

    try {
      return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const responseHeaders: Record<string, string | string[] | undefined> = {};
        const req = request({ hostname: "127.0.0.1", port: address.port, method }, (res) => {
          Object.assign(responseHeaders, res.headers);
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body }));
        });
        req.on("error", reject);
        req.end();
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("returns a private sandboxed HTML document", async () => {
    const result = await fetchMarkdown("GET", "# Rendered\n\n<script>alert(1)</script>");

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(result.body).toContain("<h1>Rendered</h1>");
    expect(result.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(Number(result.headers["content-length"])).toBe(Buffer.byteLength(result.body));
  });

  it("returns the rendered document length without a HEAD body", async () => {
    const get = await fetchMarkdown();
    const head = await fetchMarkdown("HEAD");

    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });

  it("returns an isolated capacity message for oversized Markdown", async () => {
    const result = await fetchMarkdown("GET", "x".repeat(MAX_MARKDOWN_PREVIEW_BYTES + 1));

    expect(result.status).toBe(413);
    expect(result.body).toContain("文件超过 8 MiB");
    expect(result.body).not.toContain("x".repeat(1024));
  });
});
