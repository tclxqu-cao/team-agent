#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let entry;

try {
  entry = require.resolve("agentroam-tui-darwin-arm64/entry");
} catch {
  console.error("agent-tui: TUI 可选包未安装，请重新安装 agentroam@preview");
  process.exitCode = 1;
}

if (entry) try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(`agent-tui: ${error?.message ?? error}`);
  process.exitCode = 1;
}
