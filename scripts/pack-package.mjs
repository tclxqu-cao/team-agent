#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = resolve(root, process.argv[2] || "");
const auditor = process.argv[3] ? resolve(root, process.argv[3]) : "";
if (!process.argv[2] || !auditor) throw new Error("usage: pack-package.mjs <package-dir> <audit-script>");

const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
const fileName = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
execFileSync("npm", [
  "pack",
  packageDir,
  "--pack-destination",
  packageDir,
  "--ignore-scripts",
  "--workspaces=false",
], { cwd: root, stdio: "inherit" });
const tarball = resolve(packageDir, fileName);
execFileSync(process.execPath, [auditor, tarball], { cwd: root, stdio: "inherit" });
console.log(`packed ${packageJson.name}@${packageJson.version}: ${basename(tarball)}`);
