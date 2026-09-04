# Agent Runtime Continuous Upgrade Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect, validate, repair, publish, soak, promote, and roll back stable Codex, Claude Agent SDK, and OpenCode upgrades for AgentRoam.

**Architecture:** A deterministic Node.js release toolkit owns version discovery, source updates, path gates, publication, and candidate state. Five event-driven GitHub Actions workflows keep untrusted candidate code, Codex repair, provider smoke credentials, and npm/Gitee publishing credentials in separate jobs while serializing one candidate through a 24-hour soak.

**Tech Stack:** Node.js 22 ESM, Bun 1.3.10, TypeScript, Vitest, Node test runner, GitHub Actions, official npm registry, `openai/codex-action`, Gitee v5 API.

## Global Constraints

- Track only stable npm `latest` versions; reject prerelease, RC, beta, nightly, and downgrades.
- Process exactly one Agent candidate at a time from update through soak completion.
- Keep Codex, Claude, and OpenCode upgrades independent; OpenCode CLI and SDK move as one compatibility unit.
- Permit at most two Codex repair attempts and only inside the Agent-specific allowlist.
- Never expose npm, Gitee, provider-smoke, signing, or repository-write credentials to Codex.
- Publish six platform packages before the `agentroam` launcher and verify exact registry artifacts.
- Promote immutable `preview` artifacts to `latest` only after 24 hours of qualifying macOS and Windows smoke checks.
- Roll back with npm dist-tags; never unpublish.
- Preserve unrelated uncommitted `preview.11` installer work already present in the worktree.

---

### Task 1: Runtime Version Manifest and Deterministic Upgrade Tool

**Files:**
- Create: `.github/agent-runtime-versions.json`
- Create: `scripts/agent-runtime-upgrade-lib.mjs`
- Create: `scripts/agent-runtime-upgrade.mjs`
- Create: `scripts/agent-runtime-upgrade.test.mjs`

**Interfaces:**
- Consumes: official npm registry packuments and the current repository files.
- Produces: `loadRuntimeManifest(root)`, `detectAgentUpgrade(agent, options)`, `nextAgentRoamVersion(version)`, `checkRuntimeVersionDrift(root)`, `applyAgentUpgrade(root, candidate)`, and CLI commands `detect`, `detect-all`, `check`, `apply`, and `next-release`.

- [ ] **Step 1: Add the checked-in manifest**

Create the manifest with the currently supported stable versions and explicit package names:

```json
{
  "schemaVersion": 1,
  "codex": { "package": "@openai/codex", "version": "0.153.0" },
  "claude": { "package": "@anthropic-ai/claude-agent-sdk", "version": "0.3.259" },
  "opencode": {
    "cliPackage": "opencode-ai",
    "cliVersion": "1.18.27",
    "sdkPackage": "@opencode-ai/sdk",
    "sdkVersion": "1.18.27"
  }
}
```

- [ ] **Step 2: Implement pure discovery and SemVer rules**

Export strict stable-version helpers. `detectAgentUpgrade` accepts an injected `fetchPackument(name)` for tests, reads only `dist-tags.latest`, and returns:

```js
{
  agent: "codex" | "claude" | "opencode",
  current: { cli?: string, sdk?: string },
  target: { cli?: string, sdk?: string },
  changed: boolean
}
```

Reject malformed versions, prereleases, downgrades, missing packages, and mismatched OpenCode CLI/SDK versions.

- [ ] **Step 3: Implement drift validation**

Read exact versions from the manifest, runtime manager constants, Desktop/Server dependencies, and `bun.lock`. Return all disagreements in one error so CI gives one actionable report. Validate the seven AgentRoam package versions and installer constants as a separate release-version group.

- [ ] **Step 4: Implement mechanical version application**

Update only mapped exact occurrences. Fail when an expected occurrence count differs from its declared count. Run `bun install --lockfile-only` through an injected command runner, then rerun drift validation. Keep file mutation functions injectable so tests operate on a temporary fixture rather than the real worktree.

- [ ] **Step 5: Implement release-version reservation**

Parse `X.Y.Z-preview.N`, increment only `N`, and verify the candidate is absent from all seven official npm packages before returning it. Do not infer a new base stable version.

- [ ] **Step 6: Add Node tests**

Cover no-change detection, one upgrade for each Agent, simultaneous discovery ordering, prerelease rejection, downgrade rejection, OpenCode mismatch, exact occurrence failure, drift reporting, temporary fixture mutation, and `preview.N` incrementing.

### Task 2: Agent-Specific Diff and Dependency Gate

**Files:**
- Create: `scripts/agent-runtime-diff-policy.mjs`
- Create: `scripts/check-agent-runtime-diff.mjs`
- Create: `scripts/check-agent-runtime-diff.test.mjs`

**Interfaces:**
- Consumes: Agent name, base/head refs, and `git diff --name-status --no-renames` output.
- Produces: `validateRuntimeDiff({ agent, changes, packageDiffs })` and CLI `node scripts/check-agent-runtime-diff.mjs --agent <name> --base <sha> --head <sha>`.

- [ ] **Step 1: Define explicit allowlists and denylists**

Allow manifests/lockfile, the selected manager/adapter/client and tests, shared broker/types with matching tests, native Server bridge tests, deterministic upgrade scripts, and mechanically updated package-local release files. Deny renderer, auth, WebAuthn, pairing, tunnel/relay, workflow permission files, credentials, binaries, archives, build output, deleted tests, renames, and submodules.

- [ ] **Step 2: Validate package dependency changes semantically**

Parse package JSON before/after. Permit only the selected Agent package version and synchronized AgentRoam optional-package versions. Reject new dependencies, lifecycle scripts, registry changes, git/file dependencies, or changes to `publishConfig`.

- [ ] **Step 3: Require tests for behavioral source changes**

If an adapter, client, broker, runtime manager, or Server bridge source changes beyond mechanical version constants, require at least one matching test file in the same bounded subsystem.

- [ ] **Step 4: Add policy tests**

Test all three Agent allowlists, shared broker-with-test acceptance, missing-test rejection, renderer/auth/tunnel/workflow rejection, dependency script injection, deletion/rename rejection, and a representative valid repair diff.

### Task 3: Authenticated Native Runtime Smoke

**Files:**
- Create: `scripts/agent-runtime-live-smoke.ts`
- Create: `scripts/agent-runtime-live-smoke.test.ts`

**Interfaces:**
- Consumes: `--agent codex|claude|opencode`, isolated directory arguments, resolved runtime executables, and provider credentials supplied only by the smoke job.
- Produces: one JSON summary containing Agent/runtime version, capability results, durations, and redacted failure categories; exits nonzero on any required capability failure.

- [ ] **Step 1: Build a shared smoke harness**

Create a temporary workspace and runtime home, instantiate the selected native adapter, and provide helpers that collect events with timeouts. Never print process environments, request headers, raw credentials, full prompts, or full model output.

- [ ] **Step 2: Exercise the common session lifecycle**

For each Agent: verify health/version, discover workspaces, create a session, run a minimal first turn, require streamed content plus a terminal event, read history, resume for a second turn, and verify both user turns are present.

- [ ] **Step 3: Exercise supported control capabilities**

Run one safe filesystem tool in the temporary workspace, validate its permission path, start and abort a bounded long turn, and exercise goals, steering, fork, or archive only when the adapter capability declares support.

- [ ] **Step 4: Classify failures**

Return `compatibility`, `authentication`, `rate_limit`, `registry`, `runner`, or `unknown`. Only `compatibility` is eligible for Codex repair.

- [ ] **Step 5: Add fake-adapter tests**

Inject deterministic fake adapters to test lifecycle sequencing, capability skips, event timeout, redaction, abort cleanup, and failure classification without making network calls.

### Task 4: Idempotent Release, Dist-Tag, and Candidate State Toolkit

**Files:**
- Create: `scripts/agentroam-release-lib.mjs`
- Create: `scripts/publish-agentroam-release.mjs`
- Create: `scripts/publish-agentroam-release.test.mjs`

**Interfaces:**
- Consumes: `dist/cli-release`, official npm registry state, GitHub issue metadata, Gitee API credentials, and explicit command mode.
- Produces: CLI commands `preflight`, `publish-preview`, `verify-preview`, `promote-latest`, `rollback-preview`, `rollback-latest`, and `sync-gitee`.

- [ ] **Step 1: Model the seven-package release set**

Reuse package names from `scripts/cli-release-artifacts.mjs`. Validate one exact version, seven tarballs, installers, and `SHA256SUMS`; return a stable ordered package list with launcher last.

- [ ] **Step 2: Implement registry reads and idempotent publish planning**

Use injected npm command execution. Distinguish absent, partially present, fully present, and checksum-mismatched states. Resume missing platform publications, but never publish the launcher until all six platform versions exist.

- [ ] **Step 3: Implement exact artifact verification**

Download through an empty npm cache, compare hashes with CI artifacts, and verify all `preview` or `latest` dist-tags refer to one version. Treat registry visibility delay as bounded retryable state.

- [ ] **Step 4: Implement promotion and rollback**

Move all seven tags in platform-first/launcher-last order, verify the final set, and compensate back to the prior known-good version on an intermediate failure. Never call `npm unpublish`.

- [ ] **Step 5: Implement Gitee synchronization**

Push the exact source commit/tag without embedding credentials in URLs or logs. Through the Gitee v5 API, treat HTTP 404, JSON `null`, or missing `id` as an absent Release; create/update the Release and upload installers plus `SHA256SUMS` idempotently.

- [ ] **Step 6: Add release state tests**

Cover publish ordering, partial recovery, visibility polling, checksum mismatch, tag promotion, compensating rollback, Gitee `null` handling, retryable synchronization failure, and secret redaction.

### Task 5: Discovery and Candidate Validation Workflows

**Files:**
- Create: `.github/workflows/agent-runtime-upgrade.yml`
- Create: `.github/workflows/agent-runtime-candidate-check.yml`
- Create: `.github/agent-runtime-upgrade.md`

**Interfaces:**
- Consumes: Task 1 CLIs, Task 2 gate, Task 3 smoke, existing CLI build commands, and GitHub repository APIs.
- Produces: one labeled upgrade PR and one `agent-runtime-candidate-check` workflow result/artifact set.

- [ ] **Step 1: Add daily/manual discovery**

Run at a fixed daily UTC time plus `workflow_dispatch`. Use a repository-wide `agent-runtime-upgrade` concurrency group with `cancel-in-progress: false`. Exit successfully when an open candidate/soak issue exists or no stable upgrade is available.

- [ ] **Step 2: Create one deterministic candidate**

Choose Agent order `codex`, `claude`, `opencode`, reserve the next AgentRoam preview, apply the update, run static/focused checks, create `chore/upgrade-<agent>-<version>`, push it, open a PR, and create/link the tracking issue. Use fixed workflow-generated titles and bodies.

- [ ] **Step 3: Add candidate checks without publish credentials**

On same-repository labeled PRs, run drift/diff/focused tests, type checks, production builds, and macOS packaging. Upload candidate artifacts with checksums. On Windows, download those exact artifacts and run the existing clean-install verifier.

- [ ] **Step 4: Add provider-separated real smoke jobs**

Each Agent smoke job receives only its own GitHub environment credentials. Jobs use isolated temporary homes and upload only redacted JSON summaries. Missing credentials fail closed with a setup error.

- [ ] **Step 5: Document repository configuration**

List required GitHub environments, secret names, workflow permissions, branch-protection check name, labels, Gitee mirror expectations, and the manual dispatch/hold/rollback controls.

### Task 6: Failed-Check Codex Repair Workflow

**Files:**
- Create: `.github/workflows/agent-runtime-repair.yml`
- Create: `.github/codex/prompts/repair-agent-runtime.md`

**Interfaces:**
- Consumes: completed failed candidate-check run, normalized redacted failure summary, Agent name, PR head SHA, and `OPENAI_API_KEY` only.
- Produces: at most two scoped repair commits on the candidate branch or a terminal `needs-human` issue state.

- [ ] **Step 1: Gate trusted repair eligibility**

Use `workflow_run` code from the default branch. Resolve the same-repository PR by head SHA, require automation labels, confirm failure category `compatibility`, and count prior `agent-runtime-repair:` commits. Ignore fork PRs and non-candidate workflows.

- [ ] **Step 2: Run the official Codex action in isolation**

Pin `openai/codex-action` to the reviewed `v1` commit, checkout with `persist-credentials: false`, use `safety-strategy: drop-sudo`, `sandbox: workspace-write`, the fixed prompt file, and only `OPENAI_API_KEY`. Run it after all nonmutating preparation steps.

- [ ] **Step 3: Validate and push through a separate step**

After Codex completes, run the path/dependency gate and focused tests with no publish/provider secrets. Only then provide a scoped repository token to commit and push. Update the tracking issue with attempt number and check URL.

- [ ] **Step 4: Enforce the repair limit**

After two failed repair attempts, preserve the PR and logs, add `needs-human`, mark the candidate terminal, and allow the next scheduled Agent candidate to proceed without publishing this one.

### Task 7: Trusted Merge, Preview Publish, Soak, and Promotion Workflows

**Files:**
- Create: `.github/workflows/agent-runtime-publish.yml`
- Create: `.github/workflows/agent-runtime-soak.yml`

**Interfaces:**
- Consumes: successful candidate-check `workflow_run`, exact PR/head/base metadata, Task 4 release commands, tracking issue, and isolated publish credentials.
- Produces: merged source, immutable `preview` release, Gitee mirror/Release, hourly soak ledger, automatic `latest` promotion or dist-tag rollback.

- [ ] **Step 1: Revalidate and auto-merge from trusted workflow code**

Require same-repository automation PR, unchanged head SHA, current base SHA, successful named checks, no hold label, and a fresh API diff gate. Merge through the GitHub API and capture the exact merge commit.

- [ ] **Step 2: Rebuild without secrets**

Checkout the merge commit, run frozen install and `pack:cli:all`, verify checksums, and upload the release set. Do not expose npm, Gitee, or provider credentials in this job.

- [ ] **Step 3: Publish from artifact-only jobs**

Download audited artifacts without checking out candidate source. Publish/verify npm `preview`, then synchronize the exact commit/tag and Release to Gitee. Record `preview_started_at`, prior good tags, artifact hashes, and run URLs in the tracking issue.

- [ ] **Step 4: Run hourly soak checks**

Schedule hourly with manual dispatch. Locate exactly one active candidate, install its exact version with an empty cache on macOS/Windows, run authenticated Agent-specific smoke, and append a structured result to the tracking issue.

- [ ] **Step 5: Promote or roll back**

After 24 hours, require one successful check in every six-hour window, a final check younger than two hours, all seven preview tags aligned, no newer candidate, and no `promotion-hold`. Promote all seven `latest` tags and verify. On any candidate failure, restore `preview`; on a post-promotion rollback dispatch, restore `latest`.

### Task 8: Wire Existing CI and Operational Verification

**Files:**
- Modify: `.github/workflows/cli-release.yml`
- Modify: `.github/workflows/cli-release-verify.yml`
- Modify: `package.json`
- Modify: `packages/cli/RELEASE.md`

**Interfaces:**
- Consumes: all new scripts/workflows.
- Produces: repository-level commands and existing CI drift coverage.

- [ ] **Step 1: Add repository scripts**

Expose `test:agent-runtime-upgrade` and `check:agent-runtime-versions` commands using Node 22 and the existing test tools.

- [ ] **Step 2: Add drift and toolkit tests to existing CI**

Run manifest drift and new Node tests in both release workflows before packaging. Preserve their existing macOS-build/Windows-verify order.

- [ ] **Step 3: Update the package release runbook**

Describe automatic stable-Agent detection, preview/soak/latest behavior, required secrets, hold and rollback controls, and the distinction between CI automation and local token-based emergency publishing.

- [ ] **Step 4: Validate workflow syntax and dry-run behavior**

Run `actionlint` when available, parse every workflow as YAML, execute no-change detection against the official registry, run fixture upgrades for all Agents, and exercise release commands in `--dry-run` mode only.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
node --test scripts/agent-runtime-upgrade.test.mjs scripts/check-agent-runtime-diff.test.mjs scripts/publish-agentroam-release.test.mjs
bunx vitest run scripts/agent-runtime-live-smoke.test.ts packages/cli/src/codex-runtime-manager.test.ts packages/cli/src/opencode-runtime-manager.test.ts packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts
node scripts/agent-runtime-upgrade.mjs check
bunx tsc --noEmit -p packages/desktop/tsconfig.json
bunx tsc --noEmit -p packages/server/tsconfig.json
bunx tsc --noEmit -p packages/cli/tsconfig.json
```

Expected: every command passes. If a test fails, fix the implementation or test and rerun until it passes. Then run workflow syntax validation and all `--dry-run` publication paths, report unavailable external credentials/settings separately, and do not perform a real npm or Gitee publication for this implementation task.
