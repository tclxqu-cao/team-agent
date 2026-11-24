#!/usr/bin/env node
// 打包期构建：从 tailscale 源码（pinned tag）编出 tailscale + tailscaled，
// 打成 packages/tailscale-<target>/vendor/tailscale-<target>.tgz，并回写 manifest.json 的 size/sha256。
//
// 为什么自己构建：官方只为 Linux 发布裸 tgz，macOS/Windows 只发布 App/PKG/安装器，
// 没有可再分发的裸二进制归档。Tailscale 许可证为 BSD-3-Clause，允许再分发（保留 LICENSE）。
//
// 依赖：满足上游 go.mod 的 Go 工具链、tar。用法：
//   node scripts/build-tailscale-platform-package.mjs --target darwin-arm64 --version 1.104.4
//   node scripts/build-tailscale-platform-package.mjs --target windows-amd64 --version 1.104.4
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const read = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const target = read("--target");
const version = read("--version") ?? "1.104.4";
const packageDirectory = {
  "darwin-arm64": "tailscale-darwin-arm64",
  "windows-amd64": "tailscale-win32-x64",
}[target];
if (!packageDirectory) throw new Error("--target must be darwin-arm64 or windows-amd64");
if (!/^1\.\d+\.\d+$/.test(version)) throw new Error("--version must be a stable Tailscale version");
const template = join(repoRoot, "packages", packageDirectory);
const output = resolve(read("--output-dir") ?? template);

const goEnv = target === "darwin-arm64"
  ? { GOOS: "darwin", GOARCH: "arm64" }
  : { GOOS: "windows", GOARCH: "amd64" };
const extension = target === "windows-amd64" ? ".exe" : "";

const work = await mkdtemp(join(tmpdir(), `tailscale-build-${target}-`));
try {
  console.log(`[tailscale] fetching v${version}…`);
  const module = JSON.parse(execFileSync("go", ["mod", "download", "-json", `tailscale.com@v${version}`], {
    cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }));
  if (!module.Dir || module.Version !== `v${version}`) throw new Error("Go did not resolve the pinned Tailscale module");
  const source = module.Dir;

  const outDir = join(work, "out");
  await mkdir(outDir, { recursive: true });
  for (const command of ["tailscale", "tailscaled"]) {
    console.log(`[tailscale] building ${command} (${goEnv.GOOS}/${goEnv.GOARCH})…`);
    execFileSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X tailscale.com/version.longStamp=${version} -X tailscale.com/version.shortStamp=${version}`, "-o", join(outDir, `${command}${extension}`), `./cmd/${command}`], {
      cwd: source,
      stdio: "inherit",
      env: { ...process.env, ...goEnv, CGO_ENABLED: "0" },
    });
  }

  const archiveName = `${packageDirectory}.tgz`;
  const vendor = join(output, "vendor");
  await mkdir(vendor, { recursive: true });
  const archivePath = join(vendor, archiveName);
  // 归档内只有两个二进制，目录结构与 manifest.entries 一一对应。
  execFileSync("tar", ["-czf", archivePath, "-C", outDir, ...["tailscale", "tailscaled"].map((name) => `${name}${extension}`)], { stdio: "inherit" });

  const sha256 = await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(archivePath).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolveHash(hash.digest("hex")));
  });
  const { size } = await stat(archivePath);
  const manifest = JSON.parse(await readFile(join(template, "manifest.json"), "utf8"));
  const manifestPath = join(output, "manifest.json");
  if (output !== template) {
    for (const file of ["package.json", "README.md"]) await copyFile(join(template, file), join(output, file));
  }
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    upstreamVersion: version,
    entries: ["tailscale", "tailscaled"].map((name) => `${name}${extension}`),
    size,
    sha256,
  }, null, 2)}\n`);
  // 再分发要求保留上游许可证。
  await copyFile(join(source, "LICENSE"), join(output, "LICENSE"));
  console.log(`[tailscale] wrote ${archivePath} (${size} bytes, sha256 ${sha256})`);
} finally {
  await rm(work, { recursive: true, force: true });
}
