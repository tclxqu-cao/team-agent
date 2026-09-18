#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTROAM_GITHUB_OWNER,
  AGENTROAM_GITHUB_REPO,
  createGitClient,
  createGithubClient,
  createGiteeClient,
  createNpmClient,
  inspectPublication,
  loadReleaseManifest,
  loadReleaseSet,
  moveReleaseTag,
  publishPreviewRelease,
  redactReleaseError,
  releaseSetForVersion,
  syncGiteeRelease,
  syncGithubRelease,
  verifyRegistryArtifacts,
  writeReleaseManifest,
} from "./agentroam-release-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const [command] = args;
  const npmClient = dependencies.npmClient ?? createNpmClient();

  if (command === "promote-latest" || command === "rollback-preview" || command === "rollback-latest") {
    const targetVersion = command === "promote-latest" ? required(args, "--version") : required(args, "--to");
    const tag = command === "rollback-preview" ? "preview" : "latest";
    const releaseSet = releaseSetForVersion(targetVersion);
    const launcher = await npmClient.getVersion("agentroam", targetVersion);
    if (!launcher) throw new Error(`agentroam@${targetVersion} is not published`);
    for (const item of releaseSet.packages.filter((item) => !item.launcher)) {
      const version = launcher.optionalDependencies?.[item.name];
      if (!/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(version ?? "")) throw new Error(`missing exact dependency ${item.name}`);
      item.version = version;
    }
    if (args.includes("--dry-run")) return print({ dryRun: true, command, tag, targetVersion });
    return print(await moveReleaseTag(releaseSet, { npmClient, tag, targetVersion }));
  }

  const manifestPath = optional(args, "--manifest");
  const releaseSet = manifestPath
    ? await loadReleaseManifest(manifestPath)
    : await loadReleaseSet(root, { artifactDirectory: optional(args, "--artifacts") });
  if (command === "preflight") {
    const writeManifest = optional(args, "--write-manifest");
    if (writeManifest) await writeReleaseManifest(releaseSet, resolve(writeManifest));
    return print(releaseSummary(releaseSet));
  }

  if (command === "publish-preview") {
    if (args.includes("--dry-run")) return print({ dryRun: true, command, state: await inspectPublication(releaseSet, npmClient) });
    return print(await publishPreviewRelease(releaseSet, { npmClient }));
  }
  if (command === "verify-preview") {
    return print(await verifyRegistryArtifacts(releaseSet, npmClient, { tag: "preview" }));
  }
  if (command === "sync-gitee") {
    const sourceCommit = required(args, "--commit");
    const sourceBranch = optional(args, "--branch") ?? "master";
    const effectiveReleaseSet = await withAutoManifest(releaseSet, manifestPath);
    if (args.includes("--dry-run")) return print({ dryRun: true, command, sourceCommit, sourceBranch, version: effectiveReleaseSet.version });
    const owner = required(args, "--owner");
    const repo = required(args, "--repo");
    const token = process.env.GITEE_TOKEN;
    if (!token) throw new Error("GITEE_TOKEN is required");
    return print(await syncGiteeRelease(effectiveReleaseSet, {
      sourceCommit,
      sourceBranch,
      remote: optional(args, "--remote") ?? "gitee",
      gitClient: dependencies.gitClient ?? createGitClient(),
      giteeClient: dependencies.giteeClient ?? createGiteeClient({ owner, repo, token }),
    }));
  }
  if (command === "sync-github") {
    const sourceCommit = required(args, "--commit");
    const sourceBranch = optional(args, "--branch") ?? "main";
    const owner = optional(args, "--owner") ?? AGENTROAM_GITHUB_OWNER;
    const repo = optional(args, "--repo") ?? AGENTROAM_GITHUB_REPO;
    const effectiveReleaseSet = await withAutoManifest(releaseSet, manifestPath);
    if (args.includes("--dry-run")) return print({ dryRun: true, command, sourceCommit, sourceBranch, owner, repo, version: effectiveReleaseSet.version });
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is required to publish a GitHub release");
    return print(await syncGithubRelease(effectiveReleaseSet, {
      sourceCommit,
      sourceBranch,
      remote: optional(args, "--remote") ?? "origin",
      gitClient: dependencies.gitClient ?? createGitClient(),
      githubClient: dependencies.githubClient ?? createGithubClient({ owner, repo, token }),
    }));
  }
  throw new Error("usage: publish-agentroam-release.mjs preflight|publish-preview|verify-preview|promote-latest|rollback-preview|rollback-latest|sync-gitee|sync-github [options]");
}

// Prefer the client update manifest produced by collect-cli-artifacts when no
// explicit --manifest was given, so the release-manifest.json asset is published
// together with the installers and checksums.
async function withAutoManifest(releaseSet, manifestPath) {
  if (manifestPath) return releaseSet;
  const autoManifest = resolve(releaseSet.artifactDirectory, "release-manifest.json");
  return existsSync(autoManifest) ? loadReleaseManifest(autoManifest) : releaseSet;
}

function releaseSummary(releaseSet) {
  return {
    version: releaseSet.version,
    packages: releaseSet.packages.map(({ name, fileName, sha256, launcher }) => ({ name, fileName, sha256, launcher })),
    installers: releaseSet.installers.map(({ fileName, sha256, size }) => ({ fileName, sha256, size })),
  };
}

function optional(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args, name) {
  const value = optional(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return value;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactReleaseError(error.message)}\n`);
    process.exitCode = 1;
  });
}
