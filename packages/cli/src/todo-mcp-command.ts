import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { detectPlatform } from "./platform.js";
import { resolvePlatformRuntime } from "./platform-packages.js";
export async function runTodoMcpCommand(argv: string[]): Promise<void> {
  const at = argv.indexOf("--service"), serviceId = at >= 0 ? argv[at + 1] : undefined;
  if (!serviceId || serviceId.startsWith("-")) throw new Error("Usage: agentroam mcp todo --service <serviceId>");
  let entry: string;
  const sibling = fileURLToPath(new URL("../../native-runtime/dist/index.js", import.meta.url));
  if (existsSync(sibling)) entry = sibling;
  else {
    try { entry = createRequire(import.meta.url).resolve("@agent/native-runtime"); }
    catch { const { runtimeRoot } = resolvePlatformRuntime(detectPlatform()); entry = createRequire(`${runtimeRoot}/package.json`).resolve("@agent/native-runtime"); }
  }
  const runtime = await import(pathToFileURL(entry).href);
  if (typeof runtime.runTodoMcpStdio !== "function") throw new Error("Installed runtime lacks Todo MCP support; update the runtime");
  await runtime.runTodoMcpStdio({ serviceId });
}
