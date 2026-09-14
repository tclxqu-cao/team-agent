import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const assets = new Map([
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/service-worker.js", ["service-worker.js", "text/javascript"]],
  ["/pwa/install.js", ["install.js", "text/javascript"]],
  ["/pwa/pairing-scan.js", ["pairing-scan.js", "text/javascript"]],
  ["/pwa/offline.html", ["offline.html", "text/html; charset=utf-8"]],
  ["/pwa/icon-192.png", ["icon-192.png", "image/png"]],
  ["/pwa/icon-512.png", ["icon-512.png", "image/png"]],
]);

/** Only these non-sensitive assets bypass device authorization. No arbitrary paths. */
export function handlePwaAsset(req, res) {
  const path = new URL(req.url, "http://gateway.local").pathname;
  const asset = assets.get(path);
  if (!asset && path !== "/pwa/qr-decoder.js") return false;
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return true; }
  try {
    const body = readFileSync(asset ? new URL(`../public/pwa/${asset[0]}`, import.meta.url) : require.resolve("jsqr"));
    res.writeHead(200, { "content-type": asset?.[1] || "text/javascript", "cache-control": "no-cache", "x-content-type-options": "nosniff", ...(path === "/service-worker.js" ? { "service-worker-allowed": "/" } : {}) });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { res.writeHead(503, { "cache-control": "no-store" }); res.end(); }
  return true;
}
