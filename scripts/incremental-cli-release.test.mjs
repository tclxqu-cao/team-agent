import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { planRelease, buildCommands, prepareRelease, readReleasePlan } from "./incremental-cli-release.mjs";
import { RELEASE_PACKAGE_NAMES as names, RELEASE_PACKAGE_DIRECTORIES as directories } from "./agentroam-release-lib.mjs";

const baselinePackages = names.map((name) => ({ name, version: "0.2.0-preview.20", ...(name === "agentroam" ? { optionalDependencies: Object.fromEntries(names.slice(0, -1).map((name) => [name, "0.2.0-preview.20"])) } : {}) }));
const plan = (paths) => planRelease({ base: "baseline", version: "0.2.0-preview.21", baselinePackages, changes: paths.map((path) => ({ path, before: "old", after: "new" })) });
const changed = (result) => result.packages.filter((item) => item.changed).map((item) => item.name);

test("CLI-only change builds only launcher and keeps six previous versions", () => {
  const result = plan(["packages/cli/src/service/service-command.ts"]);
  assert.deepEqual(changed(result), ["agentroam"]);
  assert.ok(result.packages.slice(0, -1).every((item) => item.version === "0.2.0-preview.20"));
  assert.deepEqual(buildCommands(result).map(([, args]) => args), [["run", "--cwd", "packages/cli", "build"], ["scripts/pack-package.mjs", "packages/cli", "scripts/audit-cli-tarball.mjs"]]);
});

test("shared Web change builds both runtimes and launcher but no TUI or cloudflared", () => {
  const result = plan(["packages/webapp/src/main.tsx"]);
  assert.deepEqual(changed(result), [names[0], names[1], "agentroam"]);
  assert.equal(buildCommands(result).filter(([, args]) => args[0] === "scripts/stage-cli-runtime.mjs").length, 2);
});

test("Darwin helper change leaves Windows untouched", () => {
  assert.deepEqual(changed(plan(["scripts/build-cli-remote-helper.mjs"])), [names[0], "agentroam"]);
  assert.deepEqual(changed(plan(["packages/server/native/remote-helper-windows/capture.cpp"])), [names[1], "agentroam"]);
  assert.deepEqual(changed(plan(["scripts/build-windows-remote-helper.mjs"])), [names[1], "agentroam"]);
});

test("Windows cloudflared metadata only updates Windows and launcher", () => {
  const result = planRelease({ base: "baseline", version: "0.2.0-preview.21", baselinePackages, changes: [{ path: "packages/cloudflared-win32-x64/manifest.json", before: '{"upstreamVersion":"1"}', after: '{"upstreamVersion":"2"}' }] });
  assert.deepEqual(changed(result), [names[3], "agentroam"]);
});

test("Core imported by runtime and TUI invalidates all four bundles", () => {
  assert.deepEqual(changed(plan(["packages/core/src/index.ts"])), [names[0], names[1], names[4], names[5], "agentroam"]);
});

test("native-runtime invalidates both platform runtimes but not TUI or cloudflared", () => {
  const result = plan(["packages/native-runtime/src/agent-runtime/unified-session-service.ts"]);
  assert.deepEqual(changed(result), [names[0], names[1], "agentroam"]);
  const commands = buildCommands(result);
  assert.equal(commands.filter(([, args]) => args[0] === "scripts/stage-cli-runtime.mjs").length, 2);
  // native-runtime is type-checked against core's built declarations, and the
  // standalone server bundle consumes its dist, so ordering is load-bearing.
  const order = commands.map(([, args]) => args.join(" "));
  const index = (value) => order.findIndex((item) => item === value);
  assert.ok(index("run --cwd packages/core build") < index("run --cwd packages/native-runtime build"));
  assert.ok(index("run --cwd packages/native-runtime build") < index("run --cwd packages/server build"));
});

test("no source change or only generated release numbers is a no-op", () => {
  const value = planRelease({ base: "baseline", version: "0.2.0-preview.21", baselinePackages, changes: [{ path: "packages/cli/package.json", before: JSON.stringify(baselinePackages.at(-1)), after: JSON.stringify({ ...baselinePackages.at(-1), version: "0.2.0-preview.21" }) }] });
  assert.equal(value.noop, true);
  assert.deepEqual(buildCommands(value), []);
  assert.equal(plan([]).noop, true);
});

test("missing reused package aborts before any source files are written", async () => {
  await assert.rejects(prepareRelease("/nonexistent-worktree", plan(["packages/cli/src/cli.ts"]), { getVersion: async () => null }), /reused package is unavailable/);
});

test("rejects stale candidate and inconsistent baseline pins", () => {
  assert.throws(() => planRelease({ base: "x", version: "0.2.0-preview.19", baselinePackages, changes: [] }), /newer than baseline/);
  const broken = structuredClone(baselinePackages);
  broken.at(-1).optionalDependencies[names[0]] = "0.2.0-preview.18";
  assert.throws(() => planRelease({ base: "x", version: "0.2.0-preview.21", baselinePackages: broken, changes: [] }), /baseline launcher dependency mismatch/);
});

test("Git planner sees unstaged, untracked and deleted source against immutable baseline", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "agentroam-incremental-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init");
  for (let i = 0; i < names.length; i++) {
    await mkdir(resolve(cwd, directories[i]), { recursive: true });
    await writeFile(resolve(cwd, directories[i], "package.json"), JSON.stringify(baselinePackages[i]));
  }
  await mkdir(resolve(cwd, "packages/cli/src"));
  await writeFile(resolve(cwd, "packages/cli/src/deleted.ts"), "old");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  await rm(resolve(cwd, "packages/cli/src/deleted.ts"));
  await writeFile(resolve(cwd, "packages/cli/src/new.ts"), "new");
  const result = await readReleasePlan(cwd, "HEAD", "0.2.0-preview.21");
  assert.deepEqual(changed(result), ["agentroam"]);
  assert.deepEqual(result.packages.at(-1).reasons.sort(), ["packages/cli/src/deleted.ts", "packages/cli/src/new.ts"]);
  assert.match(result.base, /^[a-f0-9]{40}$/);
});

test("prepare writes only changed versions and pins actual reused artifacts", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "agentroam-prepare-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (let i = 0; i < names.length; i++) {
    await mkdir(resolve(cwd, directories[i]), { recursive: true });
    await writeFile(resolve(cwd, directories[i], "package.json"), JSON.stringify(baselinePackages[i]));
    if (i < 4) await writeFile(resolve(cwd, directories[i], "manifest.json"), JSON.stringify({ packageVersion: baselinePackages[i].version }));
  }
  for (const path of ["src/platform-packages.ts", "bin/node-preflight.mjs", "install/install-agentroam.sh", "install/install-agentroam.ps1", "src/tunnel/public-readiness.ts"]) {
    const file = resolve(cwd, "packages/cli", path);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, 'version = "0.2.0-preview.20"');
  }
  const downloaded = [];
  await prepareRelease(cwd, plan(["packages/cli/src/cli.ts"]), {
    getVersion: async (name, version) => version === "0.2.0-preview.20" ? { version } : null,
    download: async (name, version) => { downloaded.push([name, version]); return Buffer.from(name); },
  });
  const launcher = JSON.parse(await readFile(resolve(cwd, "packages/cli/package.json"), "utf8"));
  assert.equal(launcher.version, "0.2.0-preview.21");
  assert.deepEqual(launcher.optionalDependencies, baselinePackages.at(-1).optionalDependencies);
  assert.equal(downloaded.length, 6);
  const runtime = JSON.parse(await readFile(resolve(cwd, directories[0], "package.json"), "utf8"));
  assert.equal(runtime.version, "0.2.0-preview.20");
  assert.match(await readFile(resolve(cwd, "packages/cli/src/platform-packages.ts"), "utf8"), /preview\.21/);
});

test("build output never counts as new source and Windows TUI builds one target", () => {
  assert.equal(plan(["packages/desktop/release/mac-arm64/AgentRoam.app/Contents/MacOS/app"]).noop, true);
  const result = plan(["packages/tui-win32-x64/README.md"]);
  assert.deepEqual(changed(result), [names[5], "agentroam"]);
  assert.deepEqual(buildCommands(result)[0][1], ["scripts/build-tui-package.mjs", "--targets", "windows-amd64"]);
});


test("publication orchestration changes do not invalidate platform binaries", () => {
  assert.equal(plan(["scripts/agentroam-release-lib.mjs", "scripts/incremental-cli-release.mjs", "scripts/audit-cli-tarball.mjs"]).noop, true);
  const before = JSON.stringify({ scripts: { "pack:cli": "full-build", build: "build" } });
  const after = JSON.stringify({ scripts: { "pack:cli": "incremental-build", "plan:cli": "plan", build: "build" } });
  assert.equal(planRelease({ base: "baseline", version: "0.2.0-preview.21", baselinePackages, changes: [{ path: "package.json", before, after }] }).noop, true);
});
