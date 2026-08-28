#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = resolve(root, "packages/cloudflared-darwin-arm64");
const manifest = JSON.parse(await readFile(resolve(packageDir, "manifest.json"), "utf8"));
const vendorDir = resolve(packageDir, "vendor");
const target = resolve(vendorDir, manifest.archiveFileName);
const temporary = `${target}.${process.pid}.download`;

await mkdir(vendorDir, { recursive: true });
await rm(temporary, { force: true });

try {
  const args = ["-fL", "--retry", "2", "--connect-timeout", "15", "--max-time", "300"];
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (proxy) args.push("--proxy", proxy);
  args.push("-o", temporary, manifest.url);
  execFileSync("curl", args, { stdio: "inherit" });
  await validateArchive(temporary, manifest);
  await rename(temporary, target);
  console.log(`fetched ${manifest.upstreamVersion}: ${target}`);
} finally {
  await rm(temporary, { force: true });
}

async function validateArchive(path, expected) {
  const info = await stat(path);
  if (info.size !== expected.size) {
    throw new Error(`cloudflared size mismatch: expected ${expected.size}, got ${info.size}`);
  }
  const actual = await sha256File(path);
  if (actual !== expected.sha256) {
    throw new Error(`cloudflared SHA-256 mismatch: expected ${expected.sha256}, got ${actual}`);
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
