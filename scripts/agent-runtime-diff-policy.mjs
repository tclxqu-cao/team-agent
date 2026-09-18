import { AGENTROAM_PACKAGES, AGENT_ORDER, parseStableSemver } from "./agent-runtime-upgrade-lib.mjs";

const COMMON_EXACT = new Set([
  ".github/agent-runtime-versions.json",
  "bun.lock",
  "scripts/agent-runtime-upgrade-lib.mjs",
  "scripts/agent-runtime-upgrade.mjs",
  "scripts/agent-runtime-upgrade.test.mjs",
  "packages/cli/package.json",
  "packages/cli/bin/node-preflight.mjs",
  "packages/cli/src/platform-packages.ts",
  "packages/cli/src/tunnel/public-readiness.ts",
  "packages/cli/install/install-agentroam.sh",
  "packages/cli/install/install-agentroam.ps1",
  "packages/cli/install/README.md",
  "packages/cli/README.md",
  "packages/cli/RELEASE.md",
  "packages/runtime-darwin-arm64/package.json",
  "packages/runtime-darwin-arm64/manifest.json",
  "packages/runtime-win32-x64/package.json",
  "packages/runtime-win32-x64/manifest.json",
  "packages/cloudflared-darwin-arm64/package.json",
  "packages/cloudflared-darwin-arm64/manifest.json",
  "packages/cloudflared-win32-x64/package.json",
  "packages/cloudflared-win32-x64/manifest.json",
  "packages/tui-darwin-arm64/package.json",
  "packages/tui-win32-x64/package.json",
]);

const SHARED_EXACT = new Set([
  "packages/native-runtime/src/agent-runtime/agent-workspace-index.ts",
  "packages/native-runtime/src/agent-runtime/agent-workspace-index.test.ts",
  "packages/native-runtime/src/agent-runtime/native-runtime-broker.ts",
  "packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts",
  "packages/native-runtime/src/agent-runtime/types.ts",
  "packages/native-runtime/src/agent-runtime/unified-session-service.ts",
  "packages/native-runtime/src/agent-runtime/unified-session-service.test.ts",
  "packages/server/app/api/native-runtime.test.ts",
  "packages/server/app/api/agent-workspaces/agent-workspace-http.ts",
  "packages/server/app/api/agent-workspaces/route.ts",
  "packages/server/app/api/agent-workspaces/route.test.ts",
  "packages/server/app/api/agent-workspaces/[workspaceId]/sessions/route.ts",
  "packages/server/app/api/agent/abort/route.ts",
  "packages/server/app/api/agent/answer/route.ts",
  "packages/server/app/api/agent/run/route.ts",
  "packages/server/app/api/agent/runtime-health/route.ts",
  "packages/server/app/api/agent/steer/route.ts",
  "packages/server/app/api/agent/stream/route.ts",
  "packages/server/app/api/agent/stream/route.test.ts",
  "packages/server/app/api/sessions/route.ts",
  "packages/server/app/api/sessions/[id]/route.ts",
  "packages/server/app/api/sessions/[id]/changes/route.ts",
  "packages/server/app/api/sessions/[id]/changes/route.test.ts",
  "packages/server/app/api/sessions/[id]/fork/route.ts",
  "packages/server/app/api/sessions/[id]/goals/route.ts",
  "packages/server/app/api/sessions/[id]/handoff/route.ts",
]);

const AGENT_EXACT = {
  codex: new Set([
    "packages/cli/src/codex-runtime-manager.ts",
    "packages/cli/src/codex-runtime-manager.test.ts",
    "packages/cli/src/runtime-manager.ts",
    "packages/cli/src/runtime-manager.test.ts",
    "packages/cli/src/service/service-command.test.ts",
  ]),
  claude: new Set([
    "packages/native-runtime/src/agent-runtime/claude-runtime-adapter.ts",
    "packages/native-runtime/src/agent-runtime/claude-runtime-adapter.test.ts",
    "packages/desktop/package.json",
    "packages/native-runtime/package.json",
    "packages/server/package.json",
  ]),
  opencode: new Set([
    "packages/cli/src/opencode-runtime-manager.ts",
    "packages/cli/src/opencode-runtime-manager.test.ts",
    "packages/cli/src/runtime-manager.ts",
    "packages/cli/src/runtime-manager.test.ts",
    "packages/native-runtime/src/agent-runtime/opencode-runtime-adapter.ts",
    "packages/native-runtime/src/agent-runtime/opencode-runtime-adapter.test.ts",
    "packages/native-runtime/src/agent-runtime/opencode-runtime-health.test.ts",
    "packages/native-runtime/src/agent-runtime/opencode-server-client.ts",
    "packages/native-runtime/src/agent-runtime/opencode-server-client.test.ts",
    "packages/desktop/package.json",
    "packages/native-runtime/package.json",
    "packages/server/package.json",
  ]),
};

const DENIED_PATHS = [
  [/^\.github\/workflows\//, "workflow files"],
  [/(^|\/)(auth|web-auth|webauthn|pairing|credentials?)(\/|\.|-)/i, "authentication or credential files"],
  [/(^|\/)(renderer|relay)(\/|\.|-)/i, "renderer or relay files"],
  [/\/tunnel\/(?!public-readiness\.ts$)/i, "tunnel files"],
  [/^packages\/server\/app\/web\//, "renderer files"],
  [/(^|\/)(dist|build|coverage|\.next)(\/|$)/, "generated build output"],
  [/\.(?:exe|dll|node|dylib|so|tgz|zip|tar|gz|7z)$/i, "binary or archive files"],
  [/(^|\/)vendor\//, "vendored artifacts"],
  [/(^|\/)(?:\.env|npmrc)(?:\.|$)/i, "credential or registry configuration"],
];

const SOURCE_TEST_RULES = [
  [/^packages\/cli\/src\/([^/]+)\.ts$/, (match) => `packages/cli/src/${match[1]}.test.ts`],
  [/^packages\/native-runtime\/src\/agent-runtime\/([^/]+)\.ts$/, (match) => {
    if (match[1] === "types") return "packages/native-runtime/src/agent-runtime/native-runtime-broker.test.ts";
    return `packages/native-runtime/src/agent-runtime/${match[1]}.test.ts`;
  }],
];

const SERVER_SOURCE_PREFIXES = [
  "packages/server/app/api/agent/",
  "packages/server/app/api/agent-workspaces/",
  "packages/server/app/api/sessions/",
];

const AGENT_DEPENDENCY = {
  codex: null,
  claude: "@anthropic-ai/claude-agent-sdk",
  opencode: "@opencode-ai/sdk",
};

export function parseNameStatus(output) {
  if (!output.trim()) return [];
  return output.trimEnd().split("\n").map((line) => {
    const fields = line.split("\t");
    const status = fields[0];
    if (/^[RC]/.test(status)) return { status, oldPath: fields[1], path: fields[2] };
    return { status, path: fields[1] };
  });
}

export function validateRuntimeDiff({ agent, changes, packageDiffs = [] }) {
  if (!AGENT_ORDER.includes(agent)) throw new Error(`unknown Agent: ${String(agent)}`);
  const issues = [];
  const changedPaths = new Set();

  for (const change of changes) {
    const { status, path } = change;
    if (!status || !path) {
      issues.push(`malformed change entry: ${JSON.stringify(change)}`);
      continue;
    }
    changedPaths.add(path);
    if (/^[RC]/.test(status)) issues.push(`${path}: renames and copies are not allowed (${status})`);
    else if (status === "D") issues.push(`${path}: deletions are not allowed`);
    else if (!/^[AM]$/.test(status)) issues.push(`${path}: unsupported change status ${status}`);
    if (change.submodule || change.mode === "160000") issues.push(`${path}: submodules are not allowed`);

    const denied = DENIED_PATHS.find(([pattern]) => pattern.test(path));
    if (denied) issues.push(`${path}: ${denied[1]} are not allowed`);
    if (!isAllowedPath(agent, path)) issues.push(`${path}: outside the ${agent} runtime upgrade allowlist`);
  }

  const packageDiffByPath = new Map(packageDiffs.map((diff) => [diff.path, diff]));
  const releaseVersions = new Set();
  for (const path of changedPaths) {
    if (!path.endsWith("package.json")) continue;
    const diff = packageDiffByPath.get(path);
    if (!diff) {
      issues.push(`${path}: missing semantic package diff`);
      continue;
    }
    validatePackageDiff(agent, diff, issues, releaseVersions);
  }
  for (const path of packageDiffByPath.keys()) {
    if (!changedPaths.has(path)) issues.push(`${path}: package diff supplied for an unchanged file`);
  }
  if (releaseVersions.size > 1) issues.push(`AgentRoam release versions are not synchronized: ${[...releaseVersions].join(", ")}`);

  requireBehaviorTests(changedPaths, issues);
  if (issues.length) {
    const error = new Error(`runtime diff policy rejected the candidate:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    error.issues = issues;
    throw error;
  }
  return { agent, files: [...changedPaths].sort(), packageFiles: [...packageDiffByPath.keys()].sort() };
}

function isAllowedPath(agent, path) {
  if (COMMON_EXACT.has(path) || SHARED_EXACT.has(path) || AGENT_EXACT[agent].has(path)) return true;
  if (agent === "codex" && /^packages\/native-runtime\/src\/agent-runtime\/codex-[^/]+(?:\.test)?\.ts$/.test(path)) return true;
  return false;
}

function validatePackageDiff(agent, diff, issues, releaseVersions) {
  let before;
  let after;
  try {
    before = typeof diff.before === "string" ? JSON.parse(diff.before) : structuredClone(diff.before);
    after = typeof diff.after === "string" ? JSON.parse(diff.after) : structuredClone(diff.after);
  } catch (error) {
    issues.push(`${diff.path}: invalid package JSON (${error.message})`);
    return;
  }
  if (!before || !after) {
    issues.push(`${diff.path}: package creation or deletion is not allowed`);
    return;
  }

  if (!deepEqual(before.scripts, after.scripts)) issues.push(`${diff.path}: lifecycle/scripts changes are not allowed`);
  if (!deepEqual(before.publishConfig, after.publishConfig)) issues.push(`${diff.path}: publishConfig changes are not allowed`);
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const beforeValues = before[section] ?? {};
    const afterValues = after[section] ?? {};
    if (!sameKeys(beforeValues, afterValues)) issues.push(`${diff.path}: dependency keys in ${section} must not change`);
    for (const [name, value] of Object.entries(afterValues)) {
      if (/^(?:git(?:\+[^:]+)?|file|link|https?):/i.test(String(value))) {
        issues.push(`${diff.path}: ${section}.${name} uses a forbidden git/file/URL dependency`);
      }
    }
  }

  const allowedPaths = new Set();
  const selectedDependency = AGENT_DEPENDENCY[agent];
  if (selectedDependency && ["packages/desktop/package.json", "packages/native-runtime/package.json", "packages/server/package.json"].includes(diff.path)) {
    allowedPaths.add(`dependencies.${selectedDependency}`);
    const value = after.dependencies?.[selectedDependency];
    const normalized = agent === "claude" && typeof value === "string" && value.startsWith("^") ? value.slice(1) : value;
    try {
      parseStableSemver(normalized, `${diff.path} ${selectedDependency}`);
    } catch (error) {
      issues.push(error.message);
    }
  }

  if (AGENTROAM_PACKAGES.includes(after.name)) {
    allowedPaths.add("version");
    if (typeof after.version === "string") releaseVersions.add(after.version);
    if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(after.version ?? "")) issues.push(`${diff.path}: invalid AgentRoam preview version ${after.version}`);
    if (after.name === "agentroam") {
      for (const name of AGENTROAM_PACKAGES.slice(0, -1)) {
        allowedPaths.add(`optionalDependencies.${name}`);
        if (after.optionalDependencies?.[name] !== after.version) {
          issues.push(`${diff.path}: optional dependency ${name} is not synchronized to ${after.version}`);
        }
      }
    }
  }

  for (const path of changedLeafPaths(before, after)) {
    if (!allowedPaths.has(path)) issues.push(`${diff.path}: package field ${path} is not allowed to change for ${agent}`);
  }
}

function requireBehaviorTests(changedPaths, issues) {
  for (const path of changedPaths) {
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
    let required;
    for (const [pattern, testPath] of SOURCE_TEST_RULES) {
      const match = path.match(pattern);
      if (match) {
        required = testPath(match);
        break;
      }
    }
    if (!required && SERVER_SOURCE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      const sibling = path.replace(/\.ts$/, ".test.ts");
      required = changedPaths.has(sibling) ? sibling : "packages/server/app/api/native-runtime.test.ts";
    }
    if (required && !changedPaths.has(required)) issues.push(`${path}: behavioral source change requires ${required}`);
  }
}

function changedLeafPaths(before, after, prefix = "") {
  if (deepEqual(before, after)) return [];
  const beforeObject = isPlainObject(before);
  const afterObject = isPlainObject(after);
  if (!beforeObject || !afterObject) return [prefix];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => changedLeafPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(left, right) {
  return deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
