import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { MINIMUM_NODE_VERSION, assertSupportedNodeVersion, isSupportedNodeVersion } from "../packages/cli/bin/runtime-policy.mjs";

test("accepts the minimum and higher Node versions without an upper bound", () => {
  assert.equal(MINIMUM_NODE_VERSION, "22.22.0");
  for (const version of ["22.22.0", "22.23.0", "22.100.0", "23.0.0", "24.0.0", "25.8.0", "26.0.0", "100.0.0", "24.0.0+vendor.1"]) {
    assert.equal(isSupportedNodeVersion(version), true, version);
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
});

test("rejects older, incomplete, malformed, and prerelease versions", () => {
  for (const version of ["18.20.0", "20.19.0", "21.99.0", "22.1.0", "22.21.9", "22.22", "22.22.0-rc.1", "26.0.0-nightly", "024.0.0", "24.0.0.1", "24.0.0+", "24.0.0+vendor..1", "garbage", "", null]) {
    assert.equal(isSupportedNodeVersion(version), false, String(version));
    assert.throws(() => assertSupportedNodeVersion(version), /Node.js >=22\.22\.0 required/);
  }
});

test("bootstrap, packages and installers agree with the canonical policy", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("./generate-node-runtime-policy.mjs", import.meta.url)), "--check"], { stdio: "pipe" });
});

const installerVersions = ["22.21.9", "22.22.0", "22.23.0", "24.0.0", "25.8.0", "26.0.0", "100.0.0", "24.0.0+vendor.1", "26.0.0-rc.1", "024.0.0", "24.0", "bad"];

test("Shell installer uses the same minimum-version semantics", { skip: process.platform === "win32" }, () => {
  const source = readFileSync(new URL("../packages/cli/install/install-agentroam.sh", import.meta.url), "utf8");
  const helper = source.match(/version_is_supported\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  for (const version of installerVersions) {
    const output = execFileSync("/bin/sh", ["-c", `MINIMUM_NODE_VERSION='${MINIMUM_NODE_VERSION}'\n${helper}\nif version_is_supported "$1"; then printf yes; else printf no; fi`, "node-policy-test", version], { encoding: "utf8" });
    assert.equal(output, isSupportedNodeVersion(version) ? "yes" : "no", version);
  }
});

test("PowerShell installer uses the same minimum-version semantics", { skip: process.platform !== "win32" }, () => {
  const source = readFileSync(new URL("../packages/cli/install/install-agentroam.ps1", import.meta.url), "utf8");
  const helper = source.match(/function Test-NodeVersion\([\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const values = installerVersions.map(version => `'${version}'`).join(",");
  const command = `$MinimumNodeVersion = '${MINIMUM_NODE_VERSION}'\n${helper}\n@(${values}) | ForEach-Object { if (Test-NodeVersion $_) { 'yes' } else { 'no' } }`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert.deepEqual(output, installerVersions.map(version => isSupportedNodeVersion(version) ? "yes" : "no"));
});
