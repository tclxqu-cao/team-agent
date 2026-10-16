import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundledRuntimePackages } from "./bundled-runtime.mjs";

const desktop = new URL("../", import.meta.url);
const index = process.argv.indexOf("--target");
const target = index >= 0 ? process.argv[index + 1] : null;
const runtime = { "darwin-arm64": "agentroam-runtime-darwin-arm64", "windows-amd64": "agentroam-runtime-win32-x64" }[target];
if (!runtime) throw new Error("Pass --target darwin-arm64|windows-amd64");
const cli = JSON.parse(await readFile(new URL("../cli/package.json", desktop), "utf8"));
await bundledRuntimePackages(fileURLToPath(new URL("assets/runtime/", desktop)), target, cli.version, cli.optionalDependencies[runtime]);
console.log(`Verified staged ${target} runtime matches the bootstrap version pins`);
