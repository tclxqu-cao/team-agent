#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./native-binary.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist/cli-release");
const packageDirectories = [
  "packages/cli",
  "packages/runtime-darwin-arm64",
  "packages/runtime-win32-x64",
  "packages/cloudflared-darwin-arm64",
  "packages/cloudflared-win32-x64",
  "packages/tui-darwin-arm64",
  "packages/tui-win32-x64",
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const checksums = [];
for (const relativeDirectory of packageDirectories) {
  const directory = resolve(root, relativeDirectory);
  const packageJson = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  const fileName = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
  const source = resolve(directory, fileName);
  const destination = resolve(output, fileName);
  await cp(source, destination);
  checksums.push(`${await sha256File(destination)}  ${basename(destination)}`);
}

await writeFile(resolve(output, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`);
console.log(`collected ${packageDirectories.length} CLI artifacts in ${output}`);
