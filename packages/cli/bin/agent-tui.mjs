#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let entry;

try {
  const [{ detectPlatform }, { resolvePlatformTui }] = await Promise.all([
    import("../dist/platform.js"),
    import("../dist/platform-packages.js"),
  ]);
  entry = resolvePlatformTui(detectPlatform(), require);
} catch (error) {
  console.error(`agent-tui: ${error?.message ?? error}`);
  process.exitCode = 1;
}

if (entry) try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(`agent-tui: ${error?.message ?? error}`);
  process.exitCode = 1;
}
