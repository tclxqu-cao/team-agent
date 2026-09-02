#!/usr/bin/env node
import("../dist/agent-tui.js").catch((error) => {
  console.error(`agent-tui: ${error?.message ?? error}`);
  process.exitCode = 1;
});
