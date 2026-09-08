#!/usr/bin/env node
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./native-binary.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist/cli-release");
const desktop = JSON.parse(await readFile(resolve(root, "packages/desktop/package.json"), "utf8"));
const expected = [`AgentRoam-${desktop.version}-arm64.dmg`, `AgentRoam-Setup-${desktop.version}-x64.exe`];
const sources = process.argv.slice(2);
if (sources.length !== 2 || JSON.stringify(sources.map(basename).sort()) !== JSON.stringify([...expected].sort())) {
  throw new Error(`usage: collect-desktop-artifacts.mjs <${expected[0]}> <${expected[1]}>`);
}
for (const source of sources) await cp(resolve(source), resolve(output, basename(source)));
const files = (await readdir(output)).filter((name) => name !== "SHA256SUMS" && name !== "release-manifest.json" && !name.endsWith(".bundle"));
const lines = [];
for (const name of files) lines.push(`${await sha256File(resolve(output, name))}  ${name}`);
await writeFile(resolve(output, "SHA256SUMS"), `${lines.sort().join("\n")}\n`);
