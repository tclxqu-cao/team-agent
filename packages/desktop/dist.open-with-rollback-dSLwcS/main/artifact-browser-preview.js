import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseDesktopPreviewRange } from "./file-workspace-service.js";
const HOST = "127.0.0.1";
export class ArtifactBrowserPreview {
    constructor(workspace) {
        this.workspace = workspace;
        this.server = null;
        this.origin = null;
    }
    async open(path, openExternal) {
        const { ticketId } = await this.workspace.openBrowserPreview(path);
        try {
            const ticket = this.workspace.resolvePreviewTicket(ticketId, true);
            if (!ticket)
                throw new Error("预览已过期，请重试");
            const origin = await (this.origin ??= this.listen());
            await openExternal(`${origin}/${ticketId}/${encodeURIComponent(basename(ticket.path))}`);
        }
        catch (error) {
            await this.workspace.request("fs:preview-close", { ticketId });
            throw error;
        }
    }
    close() {
        this.server?.close();
        this.server?.closeAllConnections();
        this.server = null;
        this.origin = null;
    }
    listen() {
        return new Promise((resolve, reject) => {
            const server = createServer((req, res) => {
                const address = server.address();
                if (!address || typeof address === "string" || req.headers.host !== `${HOST}:${address.port}`) {
                    res.writeHead(403).end();
                    return;
                }
                void this.serve(req, res, `http://${HOST}:${address.port}`).catch(() => {
                    if (res.headersSent)
                        res.destroy();
                    else
                        res.writeHead(404).end("预览已过期或文件不可用");
                });
            });
            this.server = server;
            server.once("error", error => {
                this.close();
                reject(error);
            });
            server.listen(0, HOST, () => {
                const address = server.address();
                if (address && typeof address !== "string")
                    resolve(`http://${HOST}:${address.port}`);
            });
        });
    }
    async serve(req, res, origin) {
        res.setHeader("cache-control", "private, no-store");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("x-content-type-options", "nosniff");
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" }).end();
            return;
        }
        const [, id, ...encoded] = new URL(req.url ?? "/", origin).pathname.split("/");
        const segments = encoded.map(decodeURIComponent);
        if (!/^[a-f0-9]{48}$/.test(id ?? "") || segments.some(segment => !segment || /[\\/\0]/.test(segment))) {
            res.writeHead(404).end();
            return;
        }
        const target = this.workspace.resolveBrowserPreviewResource(id, segments.join("/"));
        if (!target) {
            res.writeHead(404).end("预览已过期或文件不可用");
            return;
        }
        const handle = await open(target.path, "r");
        try {
            const info = await handle.stat();
            if (!info.isFile()) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader("accept-ranges", "bytes");
            let range;
            try {
                range = parseDesktopPreviewRange(req.headers.range ?? null, info.size);
            }
            catch {
                res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
                return;
            }
            if (target.mime.startsWith("text/html")) {
                const assets = `${origin}/${id}/`;
                res.setHeader("content-security-policy", [
                    "sandbox allow-scripts", "default-src 'none'", "base-uri 'none'", "form-action 'none'",
                    `script-src 'unsafe-inline' ${assets}`, `style-src 'unsafe-inline' ${assets}`,
                    `img-src data: ${assets}`, `media-src ${assets}`, `font-src data: ${assets}`,
                ].join("; "));
            }
            else if (target.mime === "image/svg+xml") {
                res.setHeader("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
            }
            if (!target.primary && req.headers.origin === "null")
                res.setHeader("access-control-allow-origin", "null");
            res.setHeader("content-type", target.mime);
            res.setHeader("content-length", String(range ? range.end - range.start + 1 : info.size));
            if (range)
                res.setHeader("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
            res.writeHead(range ? 206 : 200);
            if (req.method === "HEAD" || !info.size)
                res.end();
            else
                await pipeline(handle.createReadStream({ ...range, autoClose: false }), res);
        }
        finally {
            await handle.close();
        }
    }
}
//# sourceMappingURL=artifact-browser-preview.js.map