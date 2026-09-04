import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NPM_REGISTRY = "https://registry.npmjs.org";

export const RELEASE_PACKAGE_DIRECTORIES = [
  "packages/runtime-darwin-arm64",
  "packages/runtime-win32-x64",
  "packages/cloudflared-darwin-arm64",
  "packages/cloudflared-win32-x64",
  "packages/tui-darwin-arm64",
  "packages/tui-win32-x64",
  "packages/cli",
];

export const RELEASE_PACKAGE_NAMES = [
  "agentroam-runtime-darwin-arm64",
  "agentroam-runtime-win32-x64",
  "agentroam-cloudflared-darwin-arm64",
  "agentroam-cloudflared-win32-x64",
  "agentroam-tui-darwin-arm64",
  "@caoqu/agentroam-tui-win32-x64",
  "agentroam",
];

export async function loadReleaseSet(root, options = {}) {
  const artifactDirectory = resolve(root, options.artifactDirectory ?? "dist/cli-release");
  const packages = [];
  let version;
  for (const directory of RELEASE_PACKAGE_DIRECTORIES) {
    const packageJsonPath = resolve(root, directory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (!version) version = packageJson.version;
    if (packageJson.version !== version) {
      throw new Error(`${directory} version ${packageJson.version} does not match ${version}`);
    }
    if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(packageJson.version)) {
      throw new Error(`release version must be X.Y.Z-preview.N: ${packageJson.version}`);
    }
    const fileName = packageTarballName(packageJson.name, version);
    packages.push({
      name: packageJson.name,
      version,
      directory,
      fileName,
      path: resolve(artifactDirectory, fileName),
      launcher: directory === "packages/cli",
    });
  }

  const installerNames = ["install-agentroam.sh", "install-agentroam.ps1"];
  const checksumPath = resolve(artifactDirectory, "SHA256SUMS");
  const checksums = parseChecksumFile(await readFile(checksumPath, "utf8"));
  const expectedNames = [...packages.map((item) => item.fileName), ...installerNames].sort();
  if (JSON.stringify([...checksums.keys()].sort()) !== JSON.stringify(expectedNames)) {
    throw new Error(`SHA256SUMS must contain exactly: ${expectedNames.join(", ")}`);
  }

  for (const item of packages) {
    item.sha256 = await verifyArtifactChecksum(item.path, checksums.get(item.fileName), item.fileName);
  }
  const installers = [];
  for (const fileName of installerNames) {
    const path = resolve(artifactDirectory, fileName);
    const fileStat = await stat(path);
    const sha256 = await verifyArtifactChecksum(path, checksums.get(fileName), fileName);
    installers.push({ fileName, path, sha256, size: fileStat.size });
  }
  return { version, artifactDirectory, packages, installers, checksumPath, checksums };
}

export async function writeReleaseManifest(releaseSet, path) {
  const manifest = {
    schemaVersion: 1,
    version: releaseSet.version,
    packages: releaseSet.packages.map(({ name, fileName, sha256, launcher }) => ({ name, fileName, sha256, launcher })),
    installers: releaseSet.installers.map(({ fileName, sha256, size }) => ({ fileName, sha256, size })),
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function loadReleaseManifest(path) {
  const manifestPath = resolve(path);
  const artifactDirectory = resolve(manifestPath, "..");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+-preview\.\d+$/.test(manifest.version ?? "")) {
    throw new Error("invalid release manifest schema or version");
  }
  if (JSON.stringify(manifest.packages?.map((item) => item.name)) !== JSON.stringify(RELEASE_PACKAGE_NAMES)) {
    throw new Error("release manifest package names or order are invalid");
  }
  const checksumPath = resolve(artifactDirectory, "SHA256SUMS");
  const checksums = parseChecksumFile(await readFile(checksumPath, "utf8"));
  const expectedChecksumNames = [
    ...manifest.packages.map((item) => item.fileName),
    "install-agentroam.sh",
    "install-agentroam.ps1",
  ].sort();
  if (JSON.stringify([...checksums.keys()].sort()) !== JSON.stringify(expectedChecksumNames)) {
    throw new Error(`SHA256SUMS must contain exactly: ${expectedChecksumNames.join(", ")}`);
  }
  const packages = [];
  for (let index = 0; index < manifest.packages.length; index += 1) {
    const item = manifest.packages[index];
    const fileName = packageTarballName(item.name, manifest.version);
    if (item.fileName !== fileName || Boolean(item.launcher) !== (index === manifest.packages.length - 1)) {
      throw new Error(`invalid release manifest package entry for ${item.name}`);
    }
    const artifact = { ...item, version: manifest.version, path: resolve(artifactDirectory, fileName) };
    const actual = await verifyArtifactChecksum(artifact.path, checksums.get(fileName), fileName);
    if (actual !== item.sha256) throw new Error(`release manifest checksum mismatch for ${fileName}`);
    packages.push(artifact);
  }
  const installers = [];
  for (const fileName of ["install-agentroam.sh", "install-agentroam.ps1"]) {
    const item = manifest.installers?.find((value) => value.fileName === fileName);
    if (!item) throw new Error(`release manifest is missing ${fileName}`);
    const artifact = { ...item, path: resolve(artifactDirectory, fileName) };
    const fileStat = await stat(artifact.path);
    const actual = await verifyArtifactChecksum(artifact.path, checksums.get(fileName), fileName);
    if (actual !== item.sha256 || fileStat.size !== item.size) throw new Error(`release manifest metadata mismatch for ${fileName}`);
    installers.push(artifact);
  }
  return { version: manifest.version, artifactDirectory, packages, installers, checksumPath, checksums };
}

export function releaseSetForVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(version)) throw new Error(`invalid AgentRoam version ${version}`);
  return {
    version,
    packages: RELEASE_PACKAGE_NAMES.map((name, index) => ({
      name,
      version,
      launcher: index === RELEASE_PACKAGE_NAMES.length - 1,
    })),
  };
}

export function compareAgentRoamVersions(leftValue, rightValue) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/);
    if (!match) throw new Error(`invalid AgentRoam version ${value}`);
    return { core: match.slice(1, 4).map(BigInt), preview: match[4] === undefined ? null : BigInt(match[4]) };
  };
  const left = parse(leftValue);
  const right = parse(rightValue);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (left.preview === null || right.preview === null) {
    if (left.preview === right.preview) return 0;
    return left.preview === null ? 1 : -1;
  }
  return left.preview === right.preview ? 0 : left.preview > right.preview ? 1 : -1;
}

export function parseChecksumFile(content) {
  const result = new Map();
  for (const line of content.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    if (result.has(match[2])) throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    result.set(match[2], match[1]);
  }
  return result;
}

export async function inspectPublication(releaseSet, npmClient) {
  const items = [];
  for (const item of releaseSet.packages) {
    const metadata = await npmClient.getVersion(item.name, releaseSet.version);
    items.push({ name: item.name, exists: Boolean(metadata), metadata });
  }
  const present = items.filter((item) => item.exists).length;
  return {
    state: present === 0 ? "absent" : present === items.length ? "complete" : "partial",
    version: releaseSet.version,
    items,
  };
}

export async function publishPreviewRelease(releaseSet, options) {
  const npmClient = options.npmClient;
  const published = [];
  const verified = [];
  const previousTags = new Map();
  for (const item of releaseSet.packages) previousTags.set(item.name, await npmClient.getTag(item.name, "preview"));
  try {
    for (const item of releaseSet.packages) {
      if (item.launcher && verified.length !== releaseSet.packages.length - 1) {
        throw new Error("launcher cannot publish before all six platform packages are verified");
      }
      const existing = await npmClient.getVersion(item.name, releaseSet.version);
      if (!existing) {
        await npmClient.publish(item.path, "preview");
        published.push(item.name);
        await waitForVersion(npmClient, item.name, releaseSet.version, options);
      }
      await verifyRemoteArtifact(npmClient, item);
      verified.push(item.name);
    }
    for (const item of releaseSet.packages) {
      if (await npmClient.getTag(item.name, "preview") !== releaseSet.version) {
        await npmClient.setTag(item.name, releaseSet.version, "preview");
      }
    }
    await verifyReleaseTag(releaseSet, npmClient, "preview", releaseSet.version);
    return { version: releaseSet.version, published, verified, previous: Object.fromEntries(previousTags) };
  } catch (error) {
    const compensationErrors = await restoreTags(releaseSet, npmClient, "preview", previousTags);
    const suffix = compensationErrors.length ? `; compensation errors: ${compensationErrors.join("; ")}` : "";
    throw new Error(`preview publication failed; prior tags restored${suffix}: ${errorMessage(error)}`, { cause: error });
  }
}

export async function verifyRegistryArtifacts(releaseSet, npmClient, options = {}) {
  const verified = [];
  for (const item of releaseSet.packages) {
    await waitForVersion(npmClient, item.name, releaseSet.version, options);
    await verifyRemoteArtifact(npmClient, item);
    verified.push(item.name);
  }
  if (options.tag) await verifyReleaseTag(releaseSet, npmClient, options.tag, releaseSet.version);
  return { version: releaseSet.version, verified };
}

export async function verifyReleaseTag(releaseSet, npmClient, tag, expectedVersion) {
  const values = [];
  for (const item of releaseSet.packages) {
    const actual = await npmClient.getTag(item.name, tag);
    values.push([item.name, actual]);
  }
  const wrong = values.filter(([, actual]) => actual !== expectedVersion);
  if (wrong.length) {
    throw new Error(`${tag} dist-tags are not aligned to ${expectedVersion}: ${wrong.map(([name, value]) => `${name}=${value ?? "missing"}`).join(", ")}`);
  }
  return Object.fromEntries(values);
}

export async function moveReleaseTag(releaseSet, options) {
  const { npmClient, tag, targetVersion } = options;
  if (!/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(targetVersion)) throw new Error(`invalid dist-tag target ${targetVersion}`);
  const previous = new Map();
  for (const item of releaseSet.packages) previous.set(item.name, await npmClient.getTag(item.name, tag));
  const moved = [];
  try {
    for (const item of releaseSet.packages) {
      if (previous.get(item.name) === targetVersion) continue;
      if (!await npmClient.getVersion(item.name, targetVersion)) throw new Error(`${item.name}@${targetVersion} is not published`);
      await npmClient.setTag(item.name, targetVersion, tag);
      moved.push(item.name);
    }
    await verifyReleaseTag(releaseSet, npmClient, tag, targetVersion);
    return { tag, targetVersion, previous: Object.fromEntries(previous), moved };
  } catch (error) {
    const compensationErrors = [];
    for (const name of moved.reverse()) {
      try {
        const prior = previous.get(name);
        if (prior) await npmClient.setTag(name, prior, tag);
        else if (npmClient.removeTag) await npmClient.removeTag(name, tag);
        else throw new Error("client cannot remove a newly created tag");
      } catch (compensationError) {
        compensationErrors.push(`${name}: ${errorMessage(compensationError)}`);
      }
    }
    const suffix = compensationErrors.length ? `; compensation errors: ${compensationErrors.join("; ")}` : "";
    throw new Error(`failed to move ${tag} to ${targetVersion}; prior tags restored${suffix}: ${errorMessage(error)}`, { cause: error });
  }
}

async function restoreTags(releaseSet, npmClient, tag, previous) {
  const errors = [];
  for (const item of [...releaseSet.packages].reverse()) {
    try {
      const current = await npmClient.getTag(item.name, tag);
      const prior = previous.get(item.name);
      if (current === prior) continue;
      if (prior) await npmClient.setTag(item.name, prior, tag);
      else if (npmClient.removeTag) await npmClient.removeTag(item.name, tag);
      else throw new Error("client cannot remove a newly created tag");
    } catch (error) {
      errors.push(`${item.name}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

export async function syncGiteeRelease(releaseSet, options) {
  const tag = `v${releaseSet.version}`;
  const git = options.gitClient;
  const api = options.giteeClient;
  if (!/^[0-9a-f]{40}$/i.test(options.sourceCommit)) throw new Error("sourceCommit must be a full 40-character SHA");
  await git.pushTag(options.remote ?? "gitee", options.sourceCommit, tag);

  let release = await api.getReleaseByTag(tag);
  if (!release?.id) {
    release = await api.createRelease({
      tagName: tag,
      name: `AgentRoam ${releaseSet.version}`,
      body: options.body ?? `AgentRoam ${releaseSet.version}`,
      targetCommitish: options.sourceCommit,
    });
  } else {
    release = await api.updateRelease(release.id, {
      name: `AgentRoam ${releaseSet.version}`,
      body: options.body ?? release.body ?? `AgentRoam ${releaseSet.version}`,
      targetCommitish: options.sourceCommit,
    });
  }
  if (!release?.id) throw new Error("Gitee release response is missing id");

  const assets = await api.listAssets(release.id);
  const desired = [
    ...releaseSet.installers,
    {
      fileName: basename(releaseSet.checksumPath),
      path: releaseSet.checksumPath,
      size: (await stat(releaseSet.checksumPath)).size,
    },
  ];
  const uploaded = [];
  for (const item of desired) {
    const existing = assets.find((asset) => asset.name === item.fileName);
    if (existing && Number(existing.size) === item.size) continue;
    if (existing?.id) await api.deleteAsset(release.id, existing.id);
    await api.uploadAsset(release.id, item.path, item.fileName);
    uploaded.push(item.fileName);
  }
  return { tag, releaseId: release.id, uploaded };
}

export function createNpmClient(options = {}) {
  const registry = options.registry ?? NPM_REGISTRY;
  const run = options.run ?? runCommand;
  return {
    async getVersion(name, version) {
      try {
        const output = await run("npm", ["view", `${name}@${version}`, "version", "--json", "--registry", registry], {});
        return JSON.parse(output.stdout || "null") ? { version } : null;
      } catch (error) {
        if (isNpmMissing(error)) return null;
        throw sanitizedError(error);
      }
    },
    async getTag(name, tag) {
      try {
        const output = await run("npm", ["view", name, `dist-tags.${tag}`, "--json", "--registry", registry], {});
        return JSON.parse(output.stdout || "null") || null;
      } catch (error) {
        if (isNpmMissing(error)) return null;
        throw sanitizedError(error);
      }
    },
    async publish(path, tag) {
      await run("npm", ["publish", path, "--registry", registry, "--access", "public", "--tag", tag, "--provenance=false"], {});
    },
    async download(name, version) {
      const directory = await mkdtemp(resolve(tmpdir(), "agentroam-npm-verify-"));
      const cache = resolve(directory, "cache");
      try {
        const output = await run("npm", ["pack", `${name}@${version}`, "--json", "--ignore-scripts", "--registry", registry, "--cache", cache, "--pack-destination", directory], {});
        const parsed = JSON.parse(output.stdout);
        const fileName = parsed[0]?.filename;
        if (!fileName || basename(fileName) !== fileName) throw new Error(`npm pack returned invalid filename for ${name}@${version}`);
        return readFile(resolve(directory, fileName));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async setTag(name, version, tag) {
      await run("npm", ["dist-tag", "add", `${name}@${version}`, tag, "--registry", registry], {});
    },
    async removeTag(name, tag) {
      await run("npm", ["dist-tag", "rm", name, tag, "--registry", registry], {});
    },
  };
}

export function createGitClient(options = {}) {
  const run = options.run ?? runCommand;
  return {
    async pushTag(remote, sourceCommit, tag) {
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("invalid git remote name");
      if (!/^v\d+\.\d+\.\d+-preview\.\d+$/.test(tag)) throw new Error("invalid release tag");
      await run("git", ["push", remote, `${sourceCommit}:refs/tags/${tag}`], {});
    },
  };
}

export function createGiteeClient(options) {
  const base = `https://gitee.com/api/v5/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const request = options.request ?? fetch;
  const headers = { Authorization: `token ${options.token}`, Accept: "application/json" };
  const call = async (path, init = {}, allowMissing = false) => {
    let response;
    try {
      response = await request(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    } catch (error) {
      const wrapped = sanitizedError(error);
      wrapped.retryable = true;
      throw wrapped;
    }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`Gitee API HTTP ${response.status}`);
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  };
  return {
    getReleaseByTag: (tag) => call(`/releases/tags/${encodeURIComponent(tag)}`, {}, true),
    createRelease: (value) => call("/releases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag_name: value.tagName, name: value.name, body: value.body, target_commitish: value.targetCommitish }),
    }),
    updateRelease: (id, value) => call(`/releases/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: value.name, body: value.body, target_commitish: value.targetCommitish }),
    }),
    listAssets: (id) => call(`/releases/${encodeURIComponent(id)}/attach_files`),
    deleteAsset: (id, assetId) => call(`/releases/${encodeURIComponent(id)}/attach_files/${encodeURIComponent(assetId)}`, { method: "DELETE" }),
    uploadAsset: async (id, path, fileName) => {
      const form = new FormData();
      form.append("file", new Blob([await readFile(path)]), fileName);
      return call(`/releases/${encodeURIComponent(id)}/attach_files`, { method: "POST", body: form });
    },
  };
}

export function redactReleaseError(value) {
  return String(value)
    .replace(/\b(?:npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]+|gitee_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function packageTarballName(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

async function verifyArtifactChecksum(path, expected, label) {
  if (!expected) throw new Error(`SHA256SUMS is missing ${label}`);
  const actual = sha256(await readFile(path));
  if (actual !== expected) throw new Error(`artifact checksum mismatch for ${label}: expected ${expected}, got ${actual}`);
  return actual;
}

async function verifyRemoteArtifact(npmClient, item) {
  const content = await npmClient.download(item.name, item.version);
  const actual = sha256(content);
  if (actual !== item.sha256) throw new Error(`registry checksum mismatch for ${item.name}@${item.version}`);
}

async function waitForVersion(npmClient, name, version, options) {
  const attempts = options.visibilityAttempts ?? 12;
  const sleep = options.sleep ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await npmClient.getVersion(name, version)) return;
    if (attempt < attempts) await sleep(options.visibilityDelayMs ?? 5_000);
  }
  throw new Error(`registry visibility timeout for ${name}@${version}`);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: options.env,
    });
    return { stdout, stderr };
  } catch (error) {
    throw sanitizedError(error);
  }
}

function isNpmMissing(error) {
  return /\bE404\b|404 Not Found|is not in this registry/i.test(errorMessage(error));
}

function sanitizedError(error) {
  const wrapped = new Error(redactReleaseError(errorMessage(error)), { cause: error });
  if (error && typeof error === "object" && "code" in error) wrapped.code = error.code;
  return wrapped;
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const details = [error.message, error.stderr, error.stdout].filter(Boolean).join(": ");
  return details;
}
