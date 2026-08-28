import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("usage: audit-cli-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
const packageJson = JSON.parse(
  execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
);

if (packageJson.name !== "agentroam") {
  throw new Error(`unexpected package name: ${packageJson.name}`);
}
if (packageJson.version !== "0.2.0-preview.3") {
  throw new Error(`unexpected package version: ${packageJson.version}`);
}
if (JSON.stringify(packageJson.os) !== JSON.stringify(["darwin"])) {
  throw new Error(`unexpected package os: ${JSON.stringify(packageJson.os)}`);
}
if (JSON.stringify(packageJson.cpu) !== JSON.stringify(["arm64"])) {
  throw new Error(`unexpected package cpu: ${JSON.stringify(packageJson.cpu)}`);
}
if (packageJson.bin?.agentroam !== "./bin/agentroam.mjs") {
  throw new Error(`unexpected package bin: ${JSON.stringify(packageJson.bin)}`);
}
if (packageJson.optionalDependencies?.["agentroam-cloudflared-darwin-arm64"] !== "0.2.0-preview.3") {
  throw new Error(`unexpected cloudflared optional dependency: ${JSON.stringify(packageJson.optionalDependencies)}`);
}
if (statSync(tarball).size >= 30_000_000) {
  throw new Error(`tarball exceeds 30 MB release limit: ${statSync(tarball).size}`);
}
const expectedFileName = `${packageJson.name}-${packageJson.version}.tgz`;
if (basename(tarball) !== expectedFileName) {
  throw new Error(`tarball filename mismatch: expected ${expectedFileName}`);
}

const allowed = [
  "package/package.json",
  "package/README.md",
  "package/bin/",
  "package/dist/",
  "package/runtime/",
];
const unexpected = list.filter(
  (file) => !allowed.some((entry) => file === entry || (entry.endsWith("/") && file.startsWith(entry))),
);
if (unexpected.length) {
  throw new Error(`unexpected tarball files:\n${unexpected.slice(0, 50).join("\n")}`);
}

const forbidden = [
  /\.env(?:\.|$)/,
  /\.sessions\//,
  /agent\.db/,
  /packages\/desktop/,
  /packages\/sdk/,
  /\.next-dev/,
  /\.git\//,
];
const hits = list.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (hits.length) throw new Error(`forbidden tarball files:\n${hits.join("\n")}`);

const platformLeaks = list.filter(
  (file) =>
    file.startsWith("package/runtime/node_modules/@next/swc-") ||
    (/^package\/runtime\/node_modules\/node-pty\/prebuilds\//.test(file) &&
      !file.startsWith("package/runtime/node_modules/node-pty/prebuilds/darwin-arm64/")),
);
if (platformLeaks.length) {
  throw new Error(`unexpected non-runtime platform files:\n${platformLeaks.slice(0, 50).join("\n")}`);
}

for (const required of [
  "package/bin/agentroam.mjs",
  "package/dist/cli.js",
  "package/dist/native-runtime.js",
  "package/dist/network.js",
  "package/dist/cloudflared/bundled-asset.js",
  "package/dist/cloudflared/installer.js",
  "package/dist/cloudflared/manifest.js",
  "package/dist/tunnel/pinggy-provider.js",
  "package/dist/tunnel/public-readiness.js",
  "package/dist/tunnel/relay-orchestrator.js",
  "package/runtime/ws-server.mjs",
  "package/runtime/.next/BUILD_ID",
  "package/runtime/node_modules/node-pty/package.json",
  "package/runtime/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "package/runtime/node_modules/better-sqlite3/package.json",
]) {
  if (!list.includes(required)) throw new Error(`missing tarball file: ${required}`);
}

if (list.some((file) => /cloudflared-darwin-arm64\.tgz$/.test(file))) {
  throw new Error("platform cloudflared archive leaked into the main package");
}

const nativeFiles = [
  "package/runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "package/runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
];
const auditDir = mkdtempSync(join(tmpdir(), "agentroam-audit-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", auditDir, ...nativeFiles]);
  for (const nativeFile of nativeFiles) {
    const description = execFileSync("file", [join(auditDir, nativeFile)], { encoding: "utf8" });
    if (!description.includes("Mach-O 64-bit") || !description.includes("arm64")) {
      throw new Error(`unexpected native binary: ${description.trim()}`);
    }
  }
} finally {
  rmSync(auditDir, { recursive: true, force: true });
}

console.log(`tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);
