#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ORDER,
  applyAgentUpgrade,
  checkRuntimeVersionDrift,
  detectAgentUpgrade,
  detectAllAgentUpgrades,
  loadRuntimeManifest,
  nextAgentRoamVersion,
} from "./agent-runtime-upgrade-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "detect") {
    const [agent] = rest;
    print(await detectAgentUpgrade(agent, { root }));
    return;
  }
  if (command === "detect-all") {
    print(await detectAllAgentUpgrades({ root }));
    return;
  }
  if (command === "check") {
    print(await checkRuntimeVersionDrift(root));
    return;
  }
  if (command === "next-release") {
    const current = rest[0] ?? JSON.parse(await readFile(resolve(root, "packages/cli/package.json"), "utf8")).version;
    print({ current, next: await nextAgentRoamVersion(current) });
    return;
  }
  if (command === "apply") {
    const [agent, version] = rest;
    if (!AGENT_ORDER.includes(agent) || !version) usage();
    const releaseIndex = rest.indexOf("--agentroam-version");
    const agentroamVersion = releaseIndex >= 0 ? rest[releaseIndex + 1] : undefined;
    if (!agentroamVersion) throw new Error("apply requires --agentroam-version X.Y.Z-preview.N");
    const manifest = await loadRuntimeManifest(root);
    const current = agent === "codex"
      ? { cli: manifest.codex.version }
      : agent === "claude"
        ? { sdk: manifest.claude.version }
        : { cli: manifest.opencode.cliVersion, sdk: manifest.opencode.sdkVersion };
    const target = agent === "codex" ? { cli: version } : agent === "claude" ? { sdk: version } : { cli: version, sdk: version };
    print(await applyAgentUpgrade(root, { agent, current, target, changed: true, agentroamVersion }));
    return;
  }
  usage();
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  throw new Error("usage: agent-runtime-upgrade.mjs detect <agent> | detect-all | check | apply <agent> <version> --agentroam-version <version> | next-release [version]");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
