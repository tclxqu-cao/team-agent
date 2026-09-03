#!/usr/bin/env node
import("./node-preflight.mjs").then(async ({ runNodePreflight }) => {
  const result = await runNodePreflight();
  if (result.handled) {
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.exitCode ?? 1;
    return;
  }
  const { main } = await import("../dist/cli.js");
  await main(process.argv.slice(2));
}).catch((error) => {
  console.error(`agentroam: ${error?.message ?? error}`);
  process.exitCode = error?.exitCode ?? 1;
});
