import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  AGENTROAM_PACKAGES,
  applyAgentUpgrade,
  checkRuntimeVersionDrift,
  detectAgentUpgrade,
  detectAllAgentUpgrades,
  nextAgentRoamVersion,
  replaceExactOccurrences,
} from "./agent-runtime-upgrade-lib.mjs";

const manifest = {
  schemaVersion: 1,
  codex: { package: "@openai/codex", version: "1.2.3" },
  claude: { package: "@anthropic-ai/claude-agent-sdk", version: "2.3.4" },
  opencode: { cliPackage: "opencode-ai", cliVersion: "3.4.5", sdkPackage: "@opencode-ai/sdk", sdkVersion: "3.4.5" },
};

test("detects no stable changes", async () => {
  const result = await detectAgentUpgrade("codex", { manifest, fetchPackument: packuments({ "@openai/codex": "1.2.3" }) });
  assert.deepEqual(result, { agent: "codex", current: { cli: "1.2.3" }, target: { cli: "1.2.3" }, changed: false });
});

for (const [agent, packages, expected] of [
  ["codex", { "@openai/codex": "1.2.4" }, { cli: "1.2.4" }],
  ["claude", { "@anthropic-ai/claude-agent-sdk": "2.3.5" }, { sdk: "2.3.5" }],
  ["opencode", { "opencode-ai": "3.5.0", "@opencode-ai/sdk": "3.5.0" }, { cli: "3.5.0", sdk: "3.5.0" }],
]) {
  test(`detects one ${agent} upgrade`, async () => {
    const result = await detectAgentUpgrade(agent, { manifest, fetchPackument: packuments(packages) });
    assert.equal(result.changed, true);
    assert.deepEqual(result.target, expected);
  });
}

test("detect-all preserves candidate ordering", async () => {
  const result = await detectAllAgentUpgrades({
    manifest,
    fetchPackument: packuments({
      "@openai/codex": "1.2.4",
      "@anthropic-ai/claude-agent-sdk": "2.3.5",
      "opencode-ai": "3.4.6",
      "@opencode-ai/sdk": "3.4.6",
    }),
  });
  assert.deepEqual(result.map((value) => value.agent), ["codex", "claude", "opencode"]);
});

test("rejects prerelease latest", async () => {
  await assert.rejects(
    detectAgentUpgrade("codex", { manifest, fetchPackument: packuments({ "@openai/codex": "1.2.4-rc.1" }) }),
    /stable X\.Y\.Z/,
  );
});

test("rejects a downgrade", async () => {
  await assert.rejects(
    detectAgentUpgrade("claude", { manifest, fetchPackument: packuments({ "@anthropic-ai/claude-agent-sdk": "2.3.3" }) }),
    /would downgrade/,
  );
});

test("rejects mismatched OpenCode CLI and SDK latest versions", async () => {
  await assert.rejects(
    detectAgentUpgrade("opencode", { manifest, fetchPackument: packuments({ "opencode-ai": "3.4.6", "@opencode-ai/sdk": "3.4.7" }) }),
    /latest mismatch/,
  );
});

test("exact replacement fails closed on an occurrence mismatch", () => {
  assert.throws(() => replaceExactOccurrences("old old", "old", "new", 1, "fixture"), /expected 1 occurrence.*found 2/);
});

test("drift check reports every disagreement", async () => {
  const fixture = await makeFixture();
  try {
    const codexPath = resolve(fixture, "packages/cli/src/codex-runtime-manager.ts");
    await writeFile(codexPath, (await readFile(codexPath, "utf8")).replace("0.153.0", "0.152.0"));
    const serverPath = resolve(fixture, "packages/server/package.json");
    const server = JSON.parse(await readFile(serverPath, "utf8"));
    server.dependencies["@opencode-ai/sdk"] = "1.18.26";
    await writeFile(serverPath, JSON.stringify(server));
    await assert.rejects(checkRuntimeVersionDrift(fixture), (error) => {
      assert.match(error.message, /Codex runtime/);
      assert.match(error.message, /packages\/server\/package.json OpenCode dependency/);
      return true;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("drift check rejects mismatched minimums and a default below the minimum", async () => {
  const fixture = await makeFixture();
  try {
    const adapterPath = resolve(fixture, "packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts");
    await writeFile(adapterPath, (await readFile(adapterPath, "utf8")).replace('OPENCODE_MINIMUM_VERSION = "1.18.27"', 'OPENCODE_MINIMUM_VERSION = "1.18.28"'));
    await assert.rejects(checkRuntimeVersionDrift(fixture), /OpenCode minimum runtime/);
    const cliPath = resolve(fixture, "packages/cli/src/opencode-runtime-manager.ts");
    await writeFile(cliPath, (await readFile(cliPath, "utf8")).replace('OPENCODE_MINIMUM_VERSION = "1.18.27"', 'OPENCODE_MINIMUM_VERSION = "1.18.28"'));
    await assert.rejects(checkRuntimeVersionDrift(fixture), /OpenCode managed runtime must be >=1.18.28/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("applies an upgrade only inside a temporary fixture", async () => {
  const fixture = await makeFixture();
  try {
    const { currentReleaseVersion, nextReleaseVersion } = await fixtureReleaseVersions(fixture);
    const result = await applyAgentUpgrade(fixture, {
      agent: "opencode",
      current: { cli: "1.18.27", sdk: "1.18.27" },
      target: { cli: "1.18.28", sdk: "1.18.28" },
      changed: true,
      agentroamVersion: nextReleaseVersion,
    }, {
      runCommand: async (command, args, options) => {
        assert.deepEqual([command, ...args], ["bun", "install", "--lockfile-only"]);
        const lockPath = resolve(options.cwd, "bun.lock");
        const lock = await readFile(lockPath, "utf8");
        await writeFile(lockPath, lock.replaceAll("1.18.27", "1.18.28").replaceAll(currentReleaseVersion, nextReleaseVersion));
      },
    });
    assert.equal(result.agentroamVersion, nextReleaseVersion);
    for (const file of ["packages/cli/src/opencode-runtime-manager.ts", "packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts"]) {
      assert.match(await readFile(resolve(fixture, file), "utf8"), /const OPENCODE_MINIMUM_VERSION = "1\.18\.27";/);
    }
    assert.deepEqual(await checkRuntimeVersionDrift(fixture), {
      codex: "0.153.0",
      claude: "0.3.259",
      opencode: "1.18.28",
      agentroam: nextReleaseVersion,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("restores fixture files when lockfile regeneration fails", async () => {
  const fixture = await makeFixture();
  const manifestPath = resolve(fixture, ".github/agent-runtime-versions.json");
  const before = await readFile(manifestPath, "utf8");
  try {
    const { nextReleaseVersion } = await fixtureReleaseVersions(fixture);
    await assert.rejects(applyAgentUpgrade(fixture, {
      agent: "claude",
      current: { sdk: "0.3.259" },
      target: { sdk: "0.3.260" },
      changed: true,
      agentroamVersion: nextReleaseVersion,
    }, { runCommand: async () => { throw new Error("offline"); } }), /restored original files/);
    assert.equal(await readFile(manifestPath, "utf8"), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("increments preview.N and verifies all package versions are absent", async () => {
  const requested = [];
  const next = await nextAgentRoamVersion("0.2.0-preview.11", {
    fetchPackument: async (name) => { requested.push(name); return { versions: {} }; },
  });
  assert.equal(next, "0.2.0-preview.12");
  assert.deepEqual(requested, AGENTROAM_PACKAGES);
});

test("rejects an already published next preview", async () => {
  await assert.rejects(nextAgentRoamVersion("0.2.0-preview.11", {
    fetchPackument: async (name) => ({ versions: name === "agentroam" ? { "0.2.0-preview.12": {} } : {} }),
  }), /already exists.*agentroam/);
});

function packuments(versions) {
  return async (name) => {
    const version = versions[name];
    if (!version) throw new Error(`unexpected package ${name}`);
    return { "dist-tags": { latest: version }, versions: { [version]: {} } };
  };
}

async function fixtureReleaseVersions(fixture) {
  const packageJson = JSON.parse(await readFile(resolve(fixture, "packages/cli/package.json"), "utf8"));
  const match = packageJson.version.match(/^(\d+\.\d+\.\d+-preview\.)(\d+)$/);
  assert.ok(match, `invalid fixture release version: ${packageJson.version}`);
  return {
    currentReleaseVersion: packageJson.version,
    nextReleaseVersion: `${match[1]}${Number(match[2]) + 1}`,
  };
}

async function makeFixture() {
  const sourceRoot = resolve(import.meta.dirname, "..");
  const root = await mkdtemp(resolve(tmpdir(), "agent-runtime-upgrade-"));
  const files = [
    ".github/agent-runtime-versions.json",
    "bun.lock",
    "packages/desktop/package.json",
    "packages/server/package.json",
    "packages/cli/src/codex-runtime-manager.ts",
    "packages/cli/src/codex-runtime-manager.test.ts",
    "packages/cli/src/runtime-manager.test.ts",
    "packages/cli/src/service/service-command.test.ts",
    "packages/desktop/main/agent-runtime/codex-session-compatibility.test.ts",
    "packages/desktop/main/agent-runtime/codex-session-disk-catalog.test.ts",
    "packages/desktop/main/agent-runtime/codex-session-disk-catalog.bench.test.ts",
    "packages/desktop/main/agent-runtime/agent-workspace-index.test.ts",
    "packages/desktop/main/agent-runtime/native-runtime-broker.ts",
    "packages/desktop/main/agent-runtime/native-runtime-broker.test.ts",
    "packages/desktop/main/agent-runtime/unified-session-service.test.ts",
    "packages/cli/src/opencode-runtime-manager.ts",
    "packages/cli/src/opencode-runtime-manager.test.ts",
    "packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts",
    "packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts",
    "packages/runtime-darwin-arm64/package.json",
    "packages/runtime-win32-x64/package.json",
    "packages/cloudflared-darwin-arm64/package.json",
    "packages/cloudflared-win32-x64/package.json",
    "packages/tui-darwin-arm64/package.json",
    "packages/tui-win32-x64/package.json",
    "packages/cli/package.json",
    "packages/runtime-darwin-arm64/manifest.json",
    "packages/runtime-win32-x64/manifest.json",
    "packages/cloudflared-darwin-arm64/manifest.json",
    "packages/cloudflared-win32-x64/manifest.json",
    "packages/cli/bin/node-preflight.mjs",
    "packages/cli/src/platform-packages.ts",
    "packages/cli/install/install-agentroam.sh",
    "packages/cli/install/install-agentroam.ps1",
    "packages/cli/README.md",
    "packages/cli/RELEASE.md",
    "packages/cli/install/README.md",
    "packages/cli/src/tunnel/public-readiness.ts",
  ];
  for (const file of files) {
    const target = resolve(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(resolve(sourceRoot, file)));
  }
  return root;
}

test("release drift check accepts pinned independent platform versions", async () => {
  const fixture = await makeFixture();
  try {
    const cliPath = resolve(fixture, "packages/cli/package.json");
    const cli = JSON.parse(await readFile(cliPath, "utf8"));
    const runtimePath = resolve(fixture, "packages/runtime-win32-x64/package.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    runtime.version = "0.2.0-preview.1";
    cli.optionalDependencies[runtime.name] = runtime.version;
    await writeFile(cliPath, JSON.stringify(cli));
    await writeFile(runtimePath, JSON.stringify(runtime));
    const manifestPath = resolve(fixture, "packages/runtime-win32-x64/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packageVersion = runtime.version;
    await writeFile(manifestPath, JSON.stringify(manifest));
    // Installer examples in the mutable checkout are not the release snapshot.
    // Normalize only these fixture examples so this test exercises version pins.
    const io = { readFile: async (path, encoding) => {
      const source = await readFile(path, encoding);
      return path.endsWith("install-agentroam.ps1") ? `${source}\n# ${cli.version}\n` : source;
    } };
    assert.equal((await checkRuntimeVersionDrift(fixture, { io })).agentroam, cli.version);
    cli.optionalDependencies[runtime.name] = cli.version;
    await writeFile(cliPath, JSON.stringify(cli));
    await assert.rejects(checkRuntimeVersionDrift(fixture, { io }), /optional dependency agentroam-runtime-win32-x64/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
