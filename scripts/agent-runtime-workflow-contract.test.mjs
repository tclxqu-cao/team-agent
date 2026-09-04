import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function workflow(name) {
  return readFile(resolve(root, ".github/workflows", name), "utf8");
}

test("candidate publication requires authenticated smoke on macOS and Windows", async () => {
  const source = await workflow("agent-runtime-candidate-check.yml");
  assert.match(source, /authenticated-smoke:[\s\S]*os: \[macos-14, windows-2022\]/);
  assert.match(source, /environment: agent-runtime-smoke-\$\{\{ needs\.metadata\.outputs\.agent \}\}/);
  assert.match(source, /failureCategory: "authentication"/);
  assert.match(source, /Missing PROVIDER_API_KEY in agent-runtime-smoke-\$AGENT/);
  assert.match(source, /needs: \[metadata, static-checks, macos-package, windows-install, authenticated-smoke\]/);
  assert.doesNotMatch(source, /(?:codex|claude|opencode)-smoke:[\s\S]*runs-on: ubuntu-24\.04/);
});

test("Gitee failure preserves npm preview and records a retryable state", async () => {
  const source = await workflow("agent-runtime-publish.yml");
  assert.match(source, /state: "gitee-sync-pending"/);
  assert.match(source, /npm preview is healthy\. Gitee synchronization will retry automatically/);
  assert.doesNotMatch(source, /rollback-failed-preview:/);
  assert.doesNotMatch(source, /needs\.gitee-sync\.result == 'failure'\)\s*\n\s*needs: \[authorize, rebuild, npm-publish, gitee-sync, mark-gitee-pending\]/);
  assert.match(source, /retention-days: 30/);
});

test("Gitee retry reuses audited artifacts and starts soak only after recovery", async () => {
  const source = await workflow("agent-runtime-gitee-retry.yml");
  assert.match(source, /schedule:[\s\S]*cron: "7 \* \* \* \*"/);
  assert.match(source, /run-id: \$\{\{ needs\.metadata\.outputs\.publish_run \}\}/);
  assert.match(source, /verify-preview --manifest/);
  assert.match(source, /sync-gitee[\s\S]*--commit "\$MERGE_SHA"/);
  assert.match(source, /state: "soaking"/);
  assert.match(source, /The full 24-hour soak starts now/);
  assert.match(source, /healthy npm preview remains unchanged and latest promotion stays blocked/);
});

test("soak keeps hold, window, freshness, promotion, and rollback gates", async () => {
  const source = await workflow("agent-runtime-soak.yml");
  assert.match(source, /if \(process\.env\.HOLD === "true"\)/);
  assert.match(source, /\[0, 1, 2, 3\]\.every/);
  assert.match(source, /now - stamp <= 2 \* 60 \* 60 \* 1000/);
  assert.match(source, /rollback-preview --to "\$TARGET"/);
  assert.match(source, /promote-latest --version "\$VERSION"/);
});

test("repair remains pinned, scoped, and bounded to two attempts", async () => {
  const source = await workflow("agent-runtime-repair.yml");
  assert.match(source, /--pattern "agent-runtime-candidate-smoke-\*-\$HEAD_SHA"/);
  assert.match(source, /Configure PROVIDER_API_KEY in agent-runtime-smoke-/);
  assert.match(source, /uses: openai\/codex-action@[0-9a-f]{40}/);
  assert.match(source, /fromJSON\(steps\.metadata\.outputs\.attempts\) < 2/);
  assert.match(source, /safety-strategy: drop-sudo/);
  assert.match(source, /sandbox: workspace-write/);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\.(?:NPM_TOKEN|GITEE_TOKEN|PROVIDER_API_KEY)/);
});
