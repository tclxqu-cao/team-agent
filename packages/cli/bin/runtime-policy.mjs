import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync(new URL("./node-runtime-policy.json", import.meta.url), "utf8"));

export const MINIMUM_NODE_VERSION = policy.minimumNodeVersion;

export function parseNodeVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareNodeVersions(left, right) {
  const leftParts = parseNodeVersion(left);
  const rightParts = parseNodeVersion(right);
  if (!leftParts || !rightParts) throw new Error("invalid Node.js version");
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function isSupportedNodeVersion(version, minimum = MINIMUM_NODE_VERSION) {
  return parseNodeVersion(version) !== null && compareNodeVersions(version, minimum) >= 0;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (!isSupportedNodeVersion(version)) {
    throw Object.assign(new Error(`Node.js >=${MINIMUM_NODE_VERSION} required (current ${version})`), { exitCode: 2 });
  }
}

if (policy.schemaVersion !== 1 || !parseNodeVersion(MINIMUM_NODE_VERSION)) {
  throw new Error("invalid AgentRoam Node.js runtime policy");
}
