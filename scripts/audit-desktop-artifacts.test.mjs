import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { auditDesktopArtifacts, FORBIDDEN_DESKTOP_PATH } from "./audit-desktop-artifacts.mjs";

test("requires both exact native Desktop artifact names", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "desktop-artifacts-"));
  await writeFile(resolve(directory, "AgentRoam-1.2.3-arm64.dmg"), "dmg");
  await assert.rejects(auditDesktopArtifacts(directory, "1.2.3"), /Windows|Setup/);
  await writeFile(resolve(directory, "AgentRoam-Setup-1.2.3-x64.exe"), "exe");
  assert.equal((await auditDesktopArtifacts(directory, "1.2.3")).length, 2);
});

test("denies private runtime data paths", () => {
  assert.equal(FORBIDDEN_DESKTOP_PATH.test(".agent-data/session.db"), true);
  assert.equal(FORBIDDEN_DESKTOP_PATH.test("AgentRoam-1.2.3-arm64.dmg"), false);
});

test("CLI completes successfully after auditing valid artifacts", async () => {
  const { version } = JSON.parse(await readFile(new URL("../packages/desktop/package.json", import.meta.url), "utf8"));
  const directory = await mkdtemp(resolve(tmpdir(), "desktop-artifacts-cli-"));
  try {
    await writeFile(resolve(directory, `AgentRoam-${version}-arm64.dmg`), "dmg");
    await writeFile(resolve(directory, `AgentRoam-Setup-${version}-x64.exe`), "exe");
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("./audit-desktop-artifacts.mjs", import.meta.url)), directory], { encoding: "utf8" });
    assert.match(output, /audited Desktop artifacts:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
