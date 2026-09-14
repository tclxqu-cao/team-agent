import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const AGENT_ORDER = ["codex", "claude", "opencode"];
export const AGENTROAM_PACKAGES = [
  "agentroam-runtime-darwin-arm64",
  "agentroam-runtime-win32-x64",
  "agentroam-cloudflared-darwin-arm64",
  "agentroam-cloudflared-win32-x64",
  "agentroam-tui-darwin-arm64",
  "@caoqu/agentroam-tui-win32-x64",
  "agentroam",
];

const RELEASE_PACKAGE_FILES = [
  "packages/runtime-darwin-arm64/package.json",
  "packages/runtime-win32-x64/package.json",
  "packages/cloudflared-darwin-arm64/package.json",
  "packages/cloudflared-win32-x64/package.json",
  "packages/tui-darwin-arm64/package.json",
  "packages/tui-win32-x64/package.json",
  "packages/cli/package.json",
  "packages/desktop/package.json",
];

const RELEASE_MANIFEST_FILES = [
  "packages/runtime-darwin-arm64/manifest.json",
  "packages/runtime-win32-x64/manifest.json",
  "packages/cloudflared-darwin-arm64/manifest.json",
  "packages/cloudflared-win32-x64/manifest.json",
];

const RELEASE_TEXT_FILES = [
  ["packages/cli/bin/node-preflight.mjs", 1],
  ["packages/cli/src/platform-packages.ts", 1],
  ["packages/cli/install/install-agentroam.sh", 1],
  ["packages/cli/install/install-agentroam.ps1", 1],
  ["packages/cli/README.md", 8],
  ["packages/cli/RELEASE.md", 9],
  ["packages/cli/install/README.md", 3],
  ["packages/cli/src/tunnel/public-readiness.ts", 1],
];

const AGENT_TEXT_FILES = {
  codex: [
    ["packages/cli/src/codex-runtime-manager.ts", 1],
    ["packages/cli/src/codex-runtime-manager.test.ts", 8],
    ["packages/cli/src/runtime-manager.test.ts", 1],
    ["packages/cli/src/service/service-command.test.ts", 1],
    ["packages/desktop/main/agent-runtime/codex-session-compatibility.test.ts", 4],
    ["packages/desktop/main/agent-runtime/codex-session-disk-catalog.test.ts", 5],
    ["packages/desktop/main/agent-runtime/codex-session-disk-catalog.bench.test.ts", 1],
    ["packages/desktop/main/agent-runtime/agent-workspace-index.test.ts", 1],
    ["packages/desktop/main/agent-runtime/native-runtime-broker.ts", 1],
    ["packages/desktop/main/agent-runtime/native-runtime-broker.test.ts", 8],
    ["packages/desktop/main/agent-runtime/unified-session-service.test.ts", 1],
  ],
  claude: [],
  opencode: [
    ["packages/cli/src/runtime-manager.test.ts", 1],
    ["packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts", 1],
  ],
};

const DEPENDENCY_FILES = [
  "packages/desktop/package.json",
  "packages/server/package.json",
];

const defaultIo = { readFile, writeFile };

export function parseStableSemver(value, label = "version") {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a stable X.Y.Z version: ${String(value)}`);
  }
  return value.split(".").map((part) => BigInt(part));
}

export function compareStableSemver(left, right) {
  const a = parseStableSemver(left, "left version");
  const b = parseStableSemver(right, "right version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export async function loadRuntimeManifest(root, options = {}) {
  const io = { ...defaultIo, ...options.io };
  const path = resolve(root, ".github/agent-runtime-versions.json");
  let manifest;
  try {
    manifest = JSON.parse(await io.readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read runtime manifest ${path}: ${error.message}`, { cause: error });
  }
  validateRuntimeManifest(manifest);
  return manifest;
}

export function validateRuntimeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("runtime manifest schemaVersion must be 1");
  if (manifest.codex?.package !== "@openai/codex") throw new Error("runtime manifest has an invalid Codex package");
  if (manifest.claude?.package !== "@anthropic-ai/claude-agent-sdk") throw new Error("runtime manifest has an invalid Claude package");
  if (manifest.opencode?.cliPackage !== "opencode-ai" || manifest.opencode?.sdkPackage !== "@opencode-ai/sdk") {
    throw new Error("runtime manifest has invalid OpenCode packages");
  }
  parseStableSemver(manifest.codex.version, "Codex manifest version");
  parseStableSemver(manifest.claude.version, "Claude manifest version");
  parseStableSemver(manifest.opencode.cliVersion, "OpenCode CLI manifest version");
  parseStableSemver(manifest.opencode.sdkVersion, "OpenCode SDK manifest version");
  if (manifest.opencode.cliVersion !== manifest.opencode.sdkVersion) {
    throw new Error("OpenCode CLI and SDK manifest versions must match");
  }
}

export async function fetchNpmPackument(name, options = {}) {
  const registry = options.registry ?? "https://registry.npmjs.org";
  const response = await fetch(`${registry.replace(/\/$/, "")}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${name}`);
  return response.json();
}

export async function detectAgentUpgrade(agent, options = {}) {
  assertAgent(agent);
  const manifest = options.manifest ?? await loadRuntimeManifest(options.root ?? process.cwd(), options);
  const fetchPackument = options.fetchPackument ?? ((name) => fetchNpmPackument(name));

  if (agent === "codex") {
    const target = latestStable(await fetchPackument(manifest.codex.package), manifest.codex.package);
    ensureNotDowngrade(agent, manifest.codex.version, target);
    return candidate(agent, { cli: manifest.codex.version }, { cli: target });
  }
  if (agent === "claude") {
    const target = latestStable(await fetchPackument(manifest.claude.package), manifest.claude.package);
    ensureNotDowngrade(agent, manifest.claude.version, target);
    return candidate(agent, { sdk: manifest.claude.version }, { sdk: target });
  }

  const [cliPackument, sdkPackument] = await Promise.all([
    fetchPackument(manifest.opencode.cliPackage),
    fetchPackument(manifest.opencode.sdkPackage),
  ]);
  const cli = latestStable(cliPackument, manifest.opencode.cliPackage);
  const sdk = latestStable(sdkPackument, manifest.opencode.sdkPackage);
  if (cli !== sdk) throw new Error(`OpenCode latest mismatch: CLI ${cli}, SDK ${sdk}`);
  ensureNotDowngrade(agent, manifest.opencode.cliVersion, cli);
  ensureNotDowngrade(agent, manifest.opencode.sdkVersion, sdk);
  return candidate(agent, {
    cli: manifest.opencode.cliVersion,
    sdk: manifest.opencode.sdkVersion,
  }, { cli, sdk });
}

export async function detectAllAgentUpgrades(options = {}) {
  const manifest = options.manifest ?? await loadRuntimeManifest(options.root ?? process.cwd(), options);
  const results = [];
  for (const agent of AGENT_ORDER) {
    results.push(await detectAgentUpgrade(agent, { ...options, manifest }));
  }
  return results;
}

export async function checkRuntimeVersionDrift(root, options = {}) {
  const io = { ...defaultIo, ...options.io };
  const issues = [];
  let manifest;
  try {
    manifest = options.manifest ?? await loadRuntimeManifest(root, { io });
  } catch (error) {
    issues.push(error.message);
  }
  if (!manifest) throwDrift(issues);

  await checkTextValue(io, root, "packages/cli/src/codex-runtime-manager.ts", /export const CODEX_RUNTIME_VERSION = "([^"]+)";/, manifest.codex.version, "Codex runtime", issues);
  await checkTextValue(io, root, "packages/cli/src/opencode-runtime-manager.ts", /export const OPENCODE_RUNTIME_VERSION = "([^"]+)";/, manifest.opencode.cliVersion, "OpenCode managed runtime", issues);
  // A default CLI/SDK upgrade must not silently raise the supported minimum.
  try {
    const cli = await io.readFile(resolve(root, "packages/cli/src/opencode-runtime-manager.ts"), "utf8");
    const minimum = cli.match(/export const OPENCODE_MINIMUM_VERSION = "([^"]+)";/)?.[1];
    if (compareStableSemver(manifest.opencode.cliVersion, minimum) < 0) {
      issues.push(`OpenCode managed runtime must be >=${minimum}`);
    }
    await checkTextValue(io, root, "packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts", /const OPENCODE_MINIMUM_VERSION = "([^"]+)";/, minimum, "OpenCode minimum runtime", issues);
  } catch (error) {
    issues.push(`OpenCode minimum runtime: ${error.message}`);
  }

  for (const file of DEPENDENCY_FILES) {
    const packageJson = await readJsonForDrift(io, root, file, issues);
    if (!packageJson) continue;
    checkEqual(`${file} Claude dependency`, packageJson.dependencies?.[manifest.claude.package], `^${manifest.claude.version}`, issues);
    checkEqual(`${file} OpenCode dependency`, packageJson.dependencies?.[manifest.opencode.sdkPackage], manifest.opencode.sdkVersion, issues);
  }

  let lock = "";
  try {
    lock = await io.readFile(resolve(root, "bun.lock"), "utf8");
  } catch (error) {
    issues.push(`cannot read bun.lock: ${error.message}`);
  }
  if (lock) {
    checkLockDeclarations(lock, manifest, issues);
    checkLockPackageFamily(lock, "@anthropic-ai/claude-agent-sdk", manifest.claude.version, issues, true);
    checkLockPackageFamily(lock, "@opencode-ai/sdk", manifest.opencode.sdkVersion, issues, false);
  }

  const release = await checkReleaseVersionGroup(io, root, issues);
  if (issues.length) throwDrift(issues);
  return {
    codex: manifest.codex.version,
    claude: manifest.claude.version,
    opencode: manifest.opencode.cliVersion,
    agentroam: release,
  };
}

export async function applyAgentUpgrade(root, candidateValue, options = {}) {
  assertAgent(candidateValue?.agent);
  const io = { ...defaultIo, ...options.io };
  const manifest = await loadRuntimeManifest(root, { io });
  const current = agentManifestVersions(manifest, candidateValue.agent);
  if (JSON.stringify(candidateValue.current) !== JSON.stringify(current)) {
    throw new Error(`candidate current version does not match the runtime manifest for ${candidateValue.agent}`);
  }
  validateCandidateTarget(candidateValue);
  const agentroamVersion = candidateValue.agentroamVersion ?? candidateValue.agentRoamVersion;
  parsePreviewVersion(agentroamVersion);

  const originals = new Map();
  const staged = new Map();
  const read = async (relativePath) => {
    if (!staged.has(relativePath)) {
      const content = await io.readFile(resolve(root, relativePath), "utf8");
      originals.set(relativePath, content);
      staged.set(relativePath, content);
    }
    return staged.get(relativePath);
  };
  const stage = (relativePath, content) => staged.set(relativePath, content);

  const oldAgentVersion = candidateValue.agent === "opencode" ? current.cli : current.cli ?? current.sdk;
  const newAgentVersion = candidateValue.agent === "opencode" ? candidateValue.target.cli : candidateValue.target.cli ?? candidateValue.target.sdk;
  if (candidateValue.agent === "opencode") {
    const file = "packages/cli/src/opencode-runtime-manager.ts";
    stage(file, replaceExactOccurrences(await read(file),
      `export const OPENCODE_RUNTIME_VERSION = "${oldAgentVersion}";`,
      `export const OPENCODE_RUNTIME_VERSION = "${newAgentVersion}";`, 1, file));
  }
  for (const [file, expectedCount] of AGENT_TEXT_FILES[candidateValue.agent]) {
    stage(file, replaceExactOccurrences(await read(file), oldAgentVersion, newAgentVersion, expectedCount, file));
  }

  for (const file of DEPENDENCY_FILES) {
    const value = JSON.parse(await read(file));
    if (candidateValue.agent === "claude") {
      requireDependency(value, file, manifest.claude.package, `^${current.sdk}`);
      value.dependencies[manifest.claude.package] = `^${candidateValue.target.sdk}`;
    } else if (candidateValue.agent === "opencode") {
      requireDependency(value, file, manifest.opencode.sdkPackage, current.sdk);
      value.dependencies[manifest.opencode.sdkPackage] = candidateValue.target.sdk;
    }
    stage(file, formatJson(value));
  }

  const newManifest = structuredClone(manifest);
  if (candidateValue.agent === "codex") newManifest.codex.version = candidateValue.target.cli;
  if (candidateValue.agent === "claude") newManifest.claude.version = candidateValue.target.sdk;
  if (candidateValue.agent === "opencode") {
    newManifest.opencode.cliVersion = candidateValue.target.cli;
    newManifest.opencode.sdkVersion = candidateValue.target.sdk;
  }
  await read(".github/agent-runtime-versions.json");
  stage(".github/agent-runtime-versions.json", formatJson(newManifest));

  const cliPackage = JSON.parse(await read("packages/cli/package.json"));
  const oldReleaseVersion = cliPackage.version;
  parsePreviewVersion(oldReleaseVersion);
  if (comparePreviewVersions(agentroamVersion, oldReleaseVersion) <= 0) {
    throw new Error(`AgentRoam candidate ${agentroamVersion} must be newer than ${oldReleaseVersion}`);
  }
  for (const file of RELEASE_PACKAGE_FILES) {
    const value = file === "packages/cli/package.json" ? cliPackage : JSON.parse(await read(file));
    parsePreviewVersion(value.version);
    value.version = agentroamVersion;
    if (file === "packages/cli/package.json") {
      for (const packageName of AGENTROAM_PACKAGES.slice(0, -1)) {
        parsePreviewVersion(value.optionalDependencies?.[packageName]);
        value.optionalDependencies[packageName] = agentroamVersion;
      }
    }
    stage(file, formatJson(value));
  }
  for (const file of RELEASE_MANIFEST_FILES) {
    const value = JSON.parse(await read(file));
    parsePreviewVersion(value.packageVersion);
    value.packageVersion = agentroamVersion;
    stage(file, formatJson(value));
  }
  for (const [file, expectedCount] of RELEASE_TEXT_FILES) {
    stage(file, replaceExactOccurrences(await read(file), oldReleaseVersion, agentroamVersion, expectedCount, file));
  }

  await read("bun.lock");
  let wroteFiles = false;
  try {
    for (const [file, content] of staged) await io.writeFile(resolve(root, file), content);
    wroteFiles = true;
    const runCommand = options.runCommand ?? defaultRunCommand;
    await runCommand("bun", ["install", "--lockfile-only"], { cwd: root });
    await checkRuntimeVersionDrift(root, { io });
  } catch (error) {
    if (wroteFiles) {
      for (const [file, content] of originals) await io.writeFile(resolve(root, file), content);
    }
    throw new Error(`failed to apply ${candidateValue.agent} upgrade; restored original files: ${error.message}`, { cause: error });
  }
  return { ...candidateValue, agentroamVersion };
}

export async function nextAgentRoamVersion(version, options = {}) {
  const parsed = parsePreviewVersion(version);
  const next = `${parsed.base}-preview.${parsed.preview + 1n}`;
  const fetchPackument = options.fetchPackument ?? ((name) => fetchNpmPackument(name, { allowMissing: true }));
  const packageNames = options.packageNames ?? AGENTROAM_PACKAGES;
  const packuments = await Promise.all(packageNames.map(async (name) => [name, await fetchPackument(name)]));
  const occupied = packuments.filter(([, packument]) => Boolean(packument?.versions?.[next])).map(([name]) => name);
  if (occupied.length) throw new Error(`AgentRoam ${next} already exists in npm: ${occupied.join(", ")}`);
  return next;
}

export function replaceExactOccurrences(content, from, to, expectedCount, label = "content") {
  if (!from || from === to) throw new Error(`${label} replacement must change a non-empty value`);
  const actualCount = content.split(from).length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(`${label} expected ${expectedCount} occurrence(s) of ${from}, found ${actualCount}`);
  }
  return content.split(from).join(to);
}

function latestStable(packument, name) {
  if (!packument || typeof packument !== "object") throw new Error(`missing npm package ${name}`);
  const latest = packument["dist-tags"]?.latest;
  parseStableSemver(latest, `${name} dist-tags.latest`);
  if (packument.versions && !packument.versions[latest]) throw new Error(`${name} latest ${latest} is absent from versions`);
  return latest;
}

function candidate(agent, current, target) {
  return { agent, current, target, changed: JSON.stringify(current) !== JSON.stringify(target) };
}

function ensureNotDowngrade(agent, current, target) {
  if (compareStableSemver(target, current) < 0) throw new Error(`${agent} latest ${target} would downgrade ${current}`);
}

function assertAgent(agent) {
  if (!AGENT_ORDER.includes(agent)) throw new Error(`unknown Agent: ${String(agent)}`);
}

function validateCandidateTarget(value) {
  const pairs = Object.entries(value.target ?? {});
  if (!pairs.length) throw new Error("candidate target version is missing");
  for (const [name, version] of pairs) parseStableSemver(version, `${value.agent} target ${name}`);
  if (value.agent === "opencode" && value.target.cli !== value.target.sdk) {
    throw new Error("OpenCode candidate CLI and SDK versions must match");
  }
  for (const [name, current] of Object.entries(value.current)) {
    const target = value.target[name];
    if (!target || compareStableSemver(target, current) <= 0) {
      throw new Error(`${value.agent} target ${target} must be newer than ${current}`);
    }
  }
}

function agentManifestVersions(manifest, agent) {
  if (agent === "codex") return { cli: manifest.codex.version };
  if (agent === "claude") return { sdk: manifest.claude.version };
  return { cli: manifest.opencode.cliVersion, sdk: manifest.opencode.sdkVersion };
}

async function checkTextValue(io, root, file, pattern, expected, label, issues) {
  try {
    const content = await io.readFile(resolve(root, file), "utf8");
    const match = content.match(pattern);
    if (!match) issues.push(`${file} is missing ${label} constant`);
    else checkEqual(`${file} ${label}`, match[1], expected, issues);
  } catch (error) {
    issues.push(`cannot read ${file}: ${error.message}`);
  }
}

async function readJsonForDrift(io, root, file, issues) {
  try {
    return JSON.parse(await io.readFile(resolve(root, file), "utf8"));
  } catch (error) {
    issues.push(`cannot read ${file}: ${error.message}`);
    return null;
  }
}

function checkLockDeclarations(lock, manifest, issues) {
  const claude = collectDependencySpecs(lock, manifest.claude.package);
  const opencode = collectDependencySpecs(lock, manifest.opencode.sdkPackage);
  checkVersionSet("bun.lock Claude dependency declarations", claude, `^${manifest.claude.version}`, issues, 2);
  checkVersionSet("bun.lock OpenCode dependency declarations", opencode, manifest.opencode.sdkVersion, issues, 2);
}

function collectDependencySpecs(lock, packageName) {
  const escaped = escapeRegExp(packageName);
  return [...lock.matchAll(new RegExp(`"${escaped}": "([^"]+)"`, "g"))].map((match) => match[1]);
}

function checkLockPackageFamily(lock, packageName, expected, issues, includePlatformSuffixes) {
  const escaped = escapeRegExp(packageName);
  const suffix = includePlatformSuffixes ? "(?:-[a-z0-9-]+)?" : "";
  const versions = [...lock.matchAll(new RegExp(`${escaped}${suffix}@((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))`, "g"))]
    .map((match) => match[1]);
  if (!versions.length) issues.push(`bun.lock has no resolved ${packageName} package`);
  for (const version of new Set(versions)) {
    if (version !== expected) issues.push(`bun.lock resolves ${packageName} family at ${version}; expected ${expected}`);
  }
}

function checkVersionSet(label, values, expected, issues, minimumCount) {
  if (values.length < minimumCount) issues.push(`${label} expected at least ${minimumCount} entries, found ${values.length}`);
  for (const value of new Set(values)) if (value !== expected) issues.push(`${label} contains ${value}; expected ${expected}`);
}

async function checkReleaseVersionGroup(io, root, issues) {
  let expected;
  for (const file of RELEASE_PACKAGE_FILES) {
    const value = await readJsonForDrift(io, root, file, issues);
    if (!value) continue;
    if (!expected && file === "packages/cli/package.json") expected = value.version;
  }
  if (!expected) return undefined;
  try {
    parsePreviewVersion(expected);
  } catch (error) {
    issues.push(`packages/cli/package.json ${error.message}`);
  }
  const packageVersions = new Map();
  let launcher;
  for (const file of RELEASE_PACKAGE_FILES) {
    const value = await readJsonForDrift(io, root, file, issues);
    if (!value) continue;
    packageVersions.set(file, value);
    if (file === "packages/cli/package.json") launcher = value;
    try { parsePreviewVersion(value.version); }
    catch (error) { issues.push(`${file} ${error.message}`); }
  }
  for (const [file, value] of packageVersions) {
    if (!AGENTROAM_PACKAGES.slice(0, -1).includes(value.name)) continue;
    checkEqual(`packages/cli/package.json optional dependency ${value.name}`, launcher?.optionalDependencies?.[value.name], value.version, issues);
  }
  for (const file of RELEASE_MANIFEST_FILES) {
    const value = await readJsonForDrift(io, root, file, issues);
    const packageVersion = packageVersions.get(file.replace("manifest.json", "package.json"))?.version;
    if (value) checkEqual(`${file} packageVersion`, value.packageVersion, packageVersion, issues);
  }
  for (const [file] of RELEASE_TEXT_FILES.slice(0, 4)) {
    try {
      const content = await io.readFile(resolve(root, file), "utf8");
      if (!content.includes(expected)) issues.push(`${file} does not contain AgentRoam version ${expected}`);
    } catch (error) {
      issues.push(`cannot read ${file}: ${error.message}`);
    }
  }
  return expected;
}

function requireDependency(packageJson, file, name, expected) {
  if (packageJson.dependencies?.[name] !== expected) {
    throw new Error(`${file} dependency ${name} is ${packageJson.dependencies?.[name]}; expected ${expected}`);
  }
}

function checkEqual(label, actual, expected, issues) {
  if (actual !== expected) issues.push(`${label} is ${String(actual)}; expected ${expected}`);
}

function throwDrift(issues) {
  const error = new Error(`runtime version drift detected:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  error.issues = issues;
  throw error;
}

function parsePreviewVersion(value) {
  const match = typeof value === "string" && value.match(/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-preview\.(0|[1-9]\d*)$/);
  if (!match) throw new Error(`version must be X.Y.Z-preview.N: ${String(value)}`);
  return { base: match[1], preview: BigInt(match[2]) };
}

function comparePreviewVersions(left, right) {
  const a = parsePreviewVersion(left);
  const b = parsePreviewVersion(right);
  const base = compareStableSemver(a.base, b.base);
  return base || (a.preview < b.preview ? -1 : a.preview > b.preview ? 1 : 0);
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function defaultRunCommand(command, args, options) {
  await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
