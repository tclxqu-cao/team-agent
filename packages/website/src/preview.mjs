import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
};
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    ).replace(/^\/team-agent\//, "/");
    const target = resolve(
      root,
      `.${path.endsWith("/") ? `${path}index.html` : path}`,
    );
    if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(target);
    res
      .writeHead(200, {
        "Content-Type": types[extname(target)] || "application/octet-stream",
      })
      .end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(4178, "127.0.0.1", () =>
  console.log("Website → http://127.0.0.1:4178/team-agent/"),
);
