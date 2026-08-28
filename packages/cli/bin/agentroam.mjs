#!/usr/bin/env node
import("../dist/cli.js").then(({ main }) => main(process.argv.slice(2))).catch((error) => {
  console.error(`agentroam: ${error?.message ?? error}`);
  process.exitCode = error?.exitCode ?? 1;
});
