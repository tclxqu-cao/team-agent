import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The experimental WeCom bridge requires macOS arm64");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: node scripts/build-wecom-inject-helper.mjs --output <new-build-directory>");
const output = resolve(args[1]);
await mkdir(output, { recursive: false, mode: 0o700 });
const source = resolve(root, "packages/messaging/assets/wecom/NativeInjectBridge.m");
const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex");
const library = resolve(output, "NativeInjectBridge.dylib");
execFileSync("/usr/bin/clang", ["-dynamiclib", "-arch", "arm64", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
  "-framework", "Foundation", "-framework", "AppKit", "-lproc", `-DAGENT_WECOM_BRIDGE_SOURCE_SHA256=\"${sourceSha256}\"`,
  source, "-o", library], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", library], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--strict", library], { stdio: "inherit" });
await writeFile(resolve(output, "bridge-manifest.json"), JSON.stringify({ protocol: 2, sourceSha256,
  librarySha256: createHash("sha256").update(await readFile(library)).digest("hex"),
  sourceExecutableSha256: "079eabdc95281c62b4daf7f431124dff53caf5d11ccbe1f8715b2b2f56a4daf2",
  appVersion: "5.0.13", appBuild: "95049", sendingEnabledByDefault: false }, null, 2) + "\n", { mode: 0o600 });
console.log(library);
