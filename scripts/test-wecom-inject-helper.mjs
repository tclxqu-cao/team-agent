import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native bridge simulations require macOS arm64");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: node scripts/test-wecom-inject-helper.mjs --output <new-private-directory>");
const output = resolve(args[1]);
await mkdir(output, { recursive: false, mode: 0o700 });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const binary = resolve(output, "native-bridge-test");
execFileSync("/usr/bin/clang", ["-arch", "arm64", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
  "-framework", "Foundation", "-framework", "AppKit", "-lproc", resolve(root, "packages/messaging/assets/wecom/native_inject_test_host.m"),
  "-o", binary], { stdio: "inherit" });
execFileSync(binary, [resolve(output, "fixture")], { stdio: "inherit" });
