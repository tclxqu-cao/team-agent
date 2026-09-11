import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const policyText = await readFile(new URL("config/node-runtime-policy.json", root), "utf8");
const policy = JSON.parse(policyText);
if (policy.schemaVersion !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(policy.minimumNodeVersion)) {
  throw new Error("invalid Node.js runtime policy");
}
const minimum = policy.minimumNodeVersion;
const checking = process.argv.includes("--check");
const stale = [];

async function sync(relativePath, desired) {
  const destination = new URL(relativePath, root);
  const current = await readFile(destination, "utf8");
  if (current === desired) return;
  if (checking) stale.push(relativePath);
  else await writeFile(destination, desired);
}

await sync("packages/cli/bin/node-runtime-policy.json", `${JSON.stringify(policy, null, 2)}\n`);
for (const relativePath of [
  "package.json", "packages/core/package.json", "packages/server/package.json", "packages/cli/package.json",
  "packages/runtime-darwin-arm64/package.json", "packages/runtime-win32-x64/package.json",
]) {
  const source = await readFile(new URL(relativePath, root), "utf8");
  const manifest = JSON.parse(source);
  if (manifest.engines?.node === `>=${minimum}`) continue;
  manifest.engines = { ...manifest.engines, node: `>=${minimum}` };
  await sync(relativePath, `${JSON.stringify(manifest, null, 2)}\n`);
}
for (const [relativePath, expression, replacement] of [
  ["packages/cli/install/install-agentroam.sh", /^MINIMUM_NODE_VERSION="[^"]*"$/m, `MINIMUM_NODE_VERSION="${minimum}"`],
  ["packages/cli/install/install-agentroam.ps1", /^\$MinimumNodeVersion = "[^"]*"$/m, `$MinimumNodeVersion = "${minimum}"`],
]) {
  const source = await readFile(new URL(relativePath, root), "utf8");
  if (!expression.test(source)) throw new Error(`minimum Node version missing: ${relativePath}`);
  await sync(relativePath, source.replace(expression, replacement));
}
if (stale.length) throw new Error(`Node.js runtime policy is out of date: ${stale.join(", ")}`);
console.log(`Node.js >=${minimum}: runtime policy ${checking ? "verified" : "generated"}`);
