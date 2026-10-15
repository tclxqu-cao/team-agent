import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.argv[process.argv.indexOf("--target") + 1];
const runtimeDirectory = { "darwin-arm64": "runtime-darwin-arm64", "windows-amd64": "runtime-win32-x64" }[target];
if (!runtimeDirectory) throw new Error("Pass --target darwin-arm64|windows-amd64");
const outputIndex = process.argv.indexOf("--output");
const destination = outputIndex < 0 ? resolve(root, "packages/desktop/assets/runtime") : resolve(process.argv[outputIndex + 1] || "");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("Missing --output directory");
const launcher = JSON.parse(await readFile(resolve(root, "packages/cli/package.json"), "utf8"));
const runtime = JSON.parse(await readFile(resolve(root, "packages", runtimeDirectory, "package.json"), "utf8"));
const inventory = JSON.parse(await readFile(resolve(root, "packages", runtimeDirectory, "manifest.json"), "utf8"));
if (launcher.optionalDependencies[runtime.name] !== runtime.version || inventory.packageVersion !== runtime.version || inventory.target !== target || inventory.capabilities?.nativeConsole !== 1) throw new Error("Build matching native-console runtime packages before staging desktop");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const packages = [];
for (const [directory, pkg] of [["cli", launcher], [runtimeDirectory, runtime]]) {
  const file = `${pkg.name}-${pkg.version}.tgz`;
  const source = resolve(root, "packages", directory, file);
  const sha256 = createHash("sha256").update(await readFile(source)).digest("hex");
  await copyFile(source, resolve(destination, file));
  packages.push({ name: pkg.name, version: pkg.version, file, sha256 });
}
await writeFile(resolve(destination, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, target, launcherVersion: launcher.version, packages }, null, 2)}\n`);
console.log(`Staged verified desktop runtime bundle for ${target}`);
