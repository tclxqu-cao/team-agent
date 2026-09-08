#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FORBIDDEN_DESKTOP_PATH = /(?:^|\/)(?:\.agent-data|\.git|\.env(?:\.|$)|\.npmrc|sessions?|cache|\.next(?:\.|\/)|outputs?|rollback)(?:\/|$)/i;

export async function auditDesktopArtifacts(directory, expectedVersion) {
  const names = await readdir(directory);
  const expected = [
    `AgentRoam-${expectedVersion}-arm64.dmg`,
    `AgentRoam-Setup-${expectedVersion}-x64.exe`,
  ];
  for (const name of expected) {
    const path = resolve(directory, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size <= 0) throw new Error(`missing Desktop artifact ${name}`);
  }
  for (const name of names) if (FORBIDDEN_DESKTOP_PATH.test(name.replaceAll("\\", "/"))) throw new Error(`forbidden Desktop artifact path ${name}`);
  return expected;
}

async function main() {
  const directory = resolve(process.argv[2] || resolve(root, "dist/cli-release"));
  const packageJson = JSON.parse(await readFile(resolve(root, "packages/desktop/package.json"), "utf8"));
  const files = await auditDesktopArtifacts(directory, packageJson.version);
  process.stdout.write(`audited Desktop artifacts: ${files.map(basename).join(", ")}\n`);
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
