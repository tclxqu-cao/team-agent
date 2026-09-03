import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDirectories = {
  launcher: "packages/cli",
  "runtime:darwin-arm64": "packages/runtime-darwin-arm64",
  "runtime:windows-amd64": "packages/runtime-win32-x64",
  "cloudflared:darwin-arm64": "packages/cloudflared-darwin-arm64",
  "cloudflared:windows-amd64": "packages/cloudflared-win32-x64",
  "tui:darwin-arm64": "packages/tui-darwin-arm64",
  "tui:windows-amd64": "packages/tui-win32-x64",
};

export function detectReleaseTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  throw new Error(`release verification is unavailable for ${platform}-${arch}`);
}

export function releasePackageNames(target) {
  const packageName = (key) => {
    const packageJson = JSON.parse(readFileSync(resolve(root, packageDirectories[key], "package.json"), "utf8"));
    return packageJson.name;
  };
  return {
    runtime: packageName(`runtime:${target}`),
    cloudflared: packageName(`cloudflared:${target}`),
    tui: packageName(`tui:${target}`),
  };
}

export function resolveReleaseArtifacts(args, { includeTui = false } = {}) {
  const target = detectReleaseTarget();
  const artifactOption = args.indexOf("--artifacts");
  const artifactDirectory = artifactOption >= 0
    ? resolve(args[artifactOption + 1] || "")
    : resolve(root, "dist/cli-release");
  const explicitTarballs = args.filter((arg) => arg.endsWith(".tgz")).map((path) => resolve(path));
  const keys = ["launcher", `runtime:${target}`, `cloudflared:${target}`];
  if (includeTui) keys.push(`tui:${target}`);

  const artifacts = Object.fromEntries(keys.map((key) => {
    const packageDirectory = resolve(root, packageDirectories[key]);
    const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
    const fileName = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
    const explicit = explicitTarballs.find((path) => basename(path) === fileName);
    const collected = resolve(artifactDirectory, fileName);
    const path = explicit || (existsSync(collected) ? collected : resolve(packageDirectory, fileName));
    if (!existsSync(path)) throw new Error(`missing ${target} release artifact: ${path}`);
    return [key.split(":", 1)[0], path];
  }));

  verifyChecksums(artifactDirectory);
  return { target, artifactDirectory, ...artifacts };
}

function verifyChecksums(artifactDirectory) {
  const checksumFile = resolve(artifactDirectory, "SHA256SUMS");
  if (!existsSync(checksumFile)) return;
  for (const line of readFileSync(checksumFile, "utf8").trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    const path = resolve(dirname(checksumFile), match[2]);
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== match[1]) throw new Error(`release artifact checksum mismatch: ${path}`);
  }
  console.log(`verified release checksums: ${checksumFile}`);
}
