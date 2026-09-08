import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_PACKAGE_DIRECTORIES,
  compareAgentRoamVersions,
  createGitClient,
  inspectPublication,
  loadReleaseManifest,
  loadReleaseSet,
  moveReleaseTag,
  publishPreviewRelease,
  redactReleaseError,
  syncGiteeRelease,
  verifyRegistryArtifacts,
  writeReleaseManifest,
} from "./agentroam-release-lib.mjs";

test("loads one ordered seven-package release set with launcher last", async () => {
  const fixture = await releaseFixture();
  assert.equal(fixture.releaseSet.packages.length, 7);
  assert.equal(fixture.releaseSet.packages.at(-1).name, "agentroam");
  assert.equal(fixture.releaseSet.installers.length, 2);
});

test("round-trips and revalidates an artifact-only release manifest", async () => {
  const fixture = await releaseFixture();
  const path = resolve(fixture.releaseSet.artifactDirectory, "release-manifest.json");
  await writeReleaseManifest(fixture.releaseSet, path);
  const written = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  assert.equal(written.schemaVersion, 2);
  assert.equal(written.channel, "preview");
  const loaded = await loadReleaseManifest(path);
  assert.deepEqual(loaded.packages.map((item) => item.name), fixture.releaseSet.packages.map((item) => item.name));
  assert.equal(loaded.version, fixture.releaseSet.version);
});

test("blocks a stable release when either Desktop installer is absent", async () => {
  const fixture = await releaseFixture();
  for (const directory of RELEASE_PACKAGE_DIRECTORIES) {
    const path = resolve(fixture.root, directory, "package.json");
    const value = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    value.version = "0.2.0";
    await writeFile(path, `${JSON.stringify(value)}\n`);
  }
  await assert.rejects(loadReleaseSet(fixture.root), /requires both Desktop installers/);
});

test("rejects extra checksum entries in an artifact-only manifest", async () => {
  const fixture = await releaseFixture();
  const path = resolve(fixture.releaseSet.artifactDirectory, "release-manifest.json");
  await writeReleaseManifest(fixture.releaseSet, path);
  await writeFile(resolve(fixture.releaseSet.artifactDirectory, "unexpected.txt"), "unexpected");
  await appendFile(resolve(fixture.releaseSet.artifactDirectory, "SHA256SUMS"), `${hash("unexpected")}  unexpected.txt\n`);
  await assert.rejects(loadReleaseManifest(path), /must contain exactly/);
});

test("classifies absent, partial, and complete registry state", async () => {
  const { releaseSet, contents } = await releaseFixture();
  const client = fakeNpm(contents);
  assert.equal((await inspectPublication(releaseSet, client)).state, "absent");
  client.present.add(releaseSet.packages[0].name);
  assert.equal((await inspectPublication(releaseSet, client)).state, "partial");
  for (const item of releaseSet.packages) client.present.add(item.name);
  assert.equal((await inspectPublication(releaseSet, client)).state, "complete");
});

test("compares preview and stable AgentRoam versions monotonically", () => {
  assert.equal(compareAgentRoamVersions("0.2.0-preview.12", "0.2.0-preview.11"), 1);
  assert.equal(compareAgentRoamVersions("0.2.0-preview.12", "0.2.0"), -1);
  assert.equal(compareAgentRoamVersions("0.3.0-preview.1", "0.2.0"), 1);
  assert.equal(compareAgentRoamVersions("0.2.0", "0.2.0"), 0);
});

test("resumes partial preview publication platform-first and launcher-last", async () => {
  const { releaseSet, contents } = await releaseFixture();
  const client = fakeNpm(contents);
  client.present.add(releaseSet.packages[0].name);
  client.tags.preview = Object.fromEntries(releaseSet.packages.map((item) => [item.name, releaseSet.version]));
  const result = await publishPreviewRelease(releaseSet, { npmClient: client, visibilityDelayMs: 0 });
  assert.deepEqual(result.published, releaseSet.packages.slice(1).map((item) => item.name));
  assert.equal(client.calls.filter((value) => value.startsWith("publish:")).at(-1), "publish:agentroam");
});

test("polls bounded registry visibility after publish", async () => {
  const { releaseSet, contents } = await releaseFixture();
  const client = fakeNpm(contents, { visibilityDelay: 2 });
  client.tags.preview = Object.fromEntries(releaseSet.packages.map((item) => [item.name, releaseSet.version]));
  const sleeps = [];
  await publishPreviewRelease(releaseSet, {
    npmClient: client,
    visibilityAttempts: 4,
    visibilityDelayMs: 1,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.ok(sleeps.length >= releaseSet.packages.length);
});

test("rejects a registry tarball checksum mismatch", async () => {
  const { releaseSet, contents } = await releaseFixture();
  const client = fakeNpm(contents);
  for (const item of releaseSet.packages) client.present.add(item.name);
  client.downloads.set(releaseSet.packages[2].name, Buffer.from("tampered"));
  await assert.rejects(verifyRegistryArtifacts(releaseSet, client), /registry checksum mismatch/);
});

test("restores preview tags when publication fails after a partial move", async () => {
  const { releaseSet, contents } = await releaseFixture();
  const client = fakeNpm(contents);
  for (const item of releaseSet.packages) client.tags.preview[item.name] = "0.2.0-preview.10";
  client.downloads.set(releaseSet.packages[1].name, Buffer.from("tampered"));
  await assert.rejects(publishPreviewRelease(releaseSet, {
    npmClient: client,
    visibilityDelayMs: 0,
  }), /prior tags restored/);
  assert.deepEqual(new Set(Object.values(client.tags.preview)), new Set(["0.2.0-preview.10"]));
});

test("compensates dist-tags when an intermediate promotion fails", async () => {
  const { releaseSet, contents } = await releaseFixture();
  const client = fakeNpm(contents);
  for (const item of releaseSet.packages) {
    client.present.add(item.name);
    client.tags.latest[item.name] = "0.2.0-preview.10";
  }
  client.failTagFor = releaseSet.packages[2].name;
  await assert.rejects(moveReleaseTag(releaseSet, {
    npmClient: client,
    tag: "latest",
    targetVersion: releaseSet.version,
  }), /prior tags restored/);
  assert.deepEqual(new Set(Object.values(client.tags.latest)), new Set(["0.2.0-preview.10"]));
});

test("treats a null Gitee release as absent and uploads missing assets", async () => {
  const { releaseSet } = await releaseFixture();
  const calls = [];
  const result = await syncGiteeRelease(releaseSet, {
    sourceCommit: "a".repeat(40),
    sourceBranch: "master",
    gitClient: {
      pushBranch: async (...args) => calls.push(["branch", ...args]),
      pushTag: async (...args) => calls.push(["tag", ...args]),
    },
    giteeClient: {
      getReleaseByTag: async () => null,
      createRelease: async () => ({ id: 42 }),
      updateRelease: async () => { throw new Error("unexpected update"); },
      listAssets: async () => [],
      deleteAsset: async () => undefined,
      uploadAsset: async (_id, _path, name) => calls.push(["upload", name]),
    },
  });
  assert.equal(result.releaseId, 42);
  assert.equal(result.branch, "master");
  assert.deepEqual(result.uploaded, ["install-agentroam.sh", "install-agentroam.ps1", "SHA256SUMS"]);
  assert.deepEqual(calls.slice(0, 2), [
    ["branch", "gitee", "a".repeat(40), "master"],
    ["tag", "gitee", "a".repeat(40), "v0.2.0-preview.11"],
  ]);
});

test("pushes the exact source commit to a safe Gitee branch without force", async () => {
  const calls = [];
  const client = createGitClient({ run: async (...args) => calls.push(args) });
  await client.pushBranch("gitee", "c".repeat(40), "master");
  assert.deepEqual(calls, [["git", ["push", "gitee", `${"c".repeat(40)}:refs/heads/master`], {}]]);
  await assert.rejects(client.pushBranch("gitee", "c".repeat(40), "../main"), /invalid git branch/);
  await assert.rejects(client.pushBranch("gitee", "c".repeat(40), "release//next"), /invalid git branch/);
});

test("preserves retryable synchronization failures and redacts secrets", async () => {
  const { releaseSet } = await releaseFixture();
  const failure = new Error("token=gitee_supersecret");
  failure.retryable = true;
  await assert.rejects(syncGiteeRelease(releaseSet, {
    sourceCommit: "b".repeat(40),
    gitClient: { pushBranch: async () => undefined, pushTag: async () => undefined },
    giteeClient: { getReleaseByTag: async () => { throw failure; } },
  }), (error) => {
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(redactReleaseError(failure.message), "token=[REDACTED]");
});

async function releaseFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "agentroam-release-"));
  const artifactDirectory = resolve(root, "dist/cli-release");
  await mkdir(artifactDirectory, { recursive: true });
  const version = "0.2.0-preview.11";
  const names = [
    "agentroam-runtime-darwin-arm64",
    "agentroam-runtime-win32-x64",
    "agentroam-cloudflared-darwin-arm64",
    "agentroam-cloudflared-win32-x64",
    "agentroam-tui-darwin-arm64",
    "@caoqu/agentroam-tui-win32-x64",
    "agentroam",
  ];
  const checksumLines = [];
  const contents = new Map();
  for (let index = 0; index < RELEASE_PACKAGE_DIRECTORIES.length; index += 1) {
    const directory = RELEASE_PACKAGE_DIRECTORIES[index];
    await mkdir(resolve(root, directory), { recursive: true });
    await writeFile(resolve(root, directory, "package.json"), `${JSON.stringify({ name: names[index], version })}\n`);
    const fileName = `${names[index].replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
    const content = Buffer.from(`tarball:${names[index]}`);
    contents.set(names[index], content);
    await writeFile(resolve(artifactDirectory, fileName), content);
    checksumLines.push(`${hash(content)}  ${fileName}`);
  }
  for (const fileName of ["install-agentroam.sh", "install-agentroam.ps1"]) {
    const content = Buffer.from(`installer:${fileName}`);
    await writeFile(resolve(artifactDirectory, fileName), content);
    checksumLines.push(`${hash(content)}  ${fileName}`);
  }
  await writeFile(resolve(artifactDirectory, "SHA256SUMS"), `${checksumLines.sort().join("\n")}\n`);
  return { root, contents, releaseSet: await loadReleaseSet(root) };
}

function fakeNpm(contents, options = {}) {
  const present = new Set();
  const calls = [];
  const downloads = new Map(contents);
  const visibility = new Map();
  const tags = { preview: {}, latest: {} };
  return {
    present,
    calls,
    downloads,
    tags,
    failTagFor: undefined,
    async getVersion(name) {
      const remaining = visibility.get(name);
      if (remaining > 0) {
        visibility.set(name, remaining - 1);
        return null;
      }
      return present.has(name) ? { version: "0.2.0-preview.11" } : null;
    },
    async publish(path) {
      const item = [...contents.keys()].find((name) => basenameFor(name) === path.split("/").at(-1));
      calls.push(`publish:${item}`);
      present.add(item);
      tags.preview[item] = "0.2.0-preview.11";
      visibility.set(item, options.visibilityDelay ?? 0);
    },
    async download(name) {
      calls.push(`download:${name}`);
      return downloads.get(name);
    },
    async getTag(name, tag) {
      return tags[tag][name] ?? null;
    },
    async setTag(name, version, tag) {
      calls.push(`tag:${name}:${tag}:${version}`);
      if (this.failTagFor === name && version === "0.2.0-preview.11") throw new Error("tag failure");
      tags[tag][name] = version;
    },
    async removeTag(name, tag) {
      delete tags[tag][name];
    },
  };
}

function basenameFor(name) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-0.2.0-preview.11.tgz`;
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}
