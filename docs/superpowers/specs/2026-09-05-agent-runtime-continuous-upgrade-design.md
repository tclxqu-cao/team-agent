# Agent Runtime Continuous Upgrade Design

**Date:** 2026-09-05

## Goal

Keep AgentRoam aligned with the latest stable Codex, Claude Agent SDK, and OpenCode releases without allowing unverified upstream changes to reach users. Each Agent upgrades independently through detection, focused compatibility checks, bounded AI repair, full macOS and Windows validation, an immutable `preview` release, a 24-hour soak, and automatic `latest` promotion.

## Decisions

- Track stable npm `latest` releases only. Ignore prerelease, RC, beta, and nightly versions.
- Process Codex, Claude, and OpenCode as separate upgrades.
- Run automation in GitHub Actions. GitHub is the CI and PR control plane; Gitee remains a synchronized source/tag mirror and Release download source.
- Publish every successful candidate to `preview` first.
- Promote the same immutable package version to `latest` only after macOS and Windows real-runtime smoke tests remain green for 24 hours.
- On compatibility failure, let Codex attempt at most two bounded repairs. A repaired PR may auto-merge only after its diff stays inside the runtime allowlist and every required check passes.
- Do not require a human approval step. A maintainer can still stop promotion by applying a hold label.

## Current State

The repository already provides most lower-level release mechanics:

- `cli-release.yml` and `cli-release-verify.yml` build on macOS arm64 and verify installation on Windows x64.
- `pack:cli:all` produces the launcher and six platform packages, with tarball audits and a shared `SHA256SUMS`.
- Runtime managers pin Codex `0.153.0` and OpenCode `1.18.27`; the server lockfile pins Claude Agent SDK `0.3.259`.
- Package and installer versions are repeated across package manifests, launchers, installers, tests, and release documentation.
- The current workflows verify packaging and basic runtime startup, but they do not detect upstream releases, execute authenticated end-to-end Agent turns, repair protocol drift, publish automatically, soak candidates, or promote dist-tags.

The earlier `2026-09-03-agent-runtime-version-upgrade-design.md` remains the record for the completed one-time upgrade. This design owns ongoing automation.

## Architecture

### 1. Runtime Version Manifest

Add `.github/agent-runtime-versions.json` as the automation source of truth:

```json
{
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

The application may retain compile-time constants and package dependencies where required. A deterministic updater writes all consumers, and a drift checker fails CI if constants, manifests, or lockfile resolutions disagree with the central manifest. The manifest never stores credentials or release state.

### 2. Stable Release Discovery

`scripts/agent-runtime-upgrade.mjs detect <agent>` queries the official npm registry for `dist-tags.latest`, parses strict SemVer, rejects prereleases and downgrades, and confirms all required platform packages exist before returning an upgrade candidate.

Discovery runs daily and through `workflow_dispatch`. It emits normalized version metadata only; raw upstream release notes, issue text, and package README content are not inserted into AI prompts. This prevents untrusted registry content from becoming prompt instructions.

OpenCode detection treats the CLI and SDK as one compatibility unit. The updater requires equal stable versions unless an explicit compatibility mapping is added to the manifest and covered by tests.

### 3. Globally Serialized Candidates

Only one Agent candidate may be active from version mutation through the end of its soak. Other detected upgrades remain pending for the next scheduled run. This deliberately trades throughput for deterministic release ordering:

1. Every candidate starts from the current default branch and current npm `latest` AgentRoam version.
2. The candidate reserves exactly one next `preview.N` version.
3. A failed candidate can roll back without later releases depending on it.
4. `latest` promotions are monotonic and cannot promote an older candidate over a newer one.

GitHub Actions uses a repository-wide concurrency group with cancellation disabled. A tracking issue labeled `agent-runtime-upgrade` records the Agent name, old/new runtime versions, AgentRoam candidate version, commit, soak start, hourly checks, and terminal result. Adding `promotion-hold` blocks promotion without cancelling validation.

### 4. Deterministic Version Update

`scripts/agent-runtime-upgrade.mjs apply <agent> <version> --agentroam-version <version>` performs only mechanical changes:

- update `.github/agent-runtime-versions.json`;
- update Codex or OpenCode runtime constants;
- update Claude or OpenCode SDK dependencies;
- regenerate `bun.lock` with the pinned Bun version;
- advance all seven AgentRoam package versions together;
- update versioned launcher and installer constants;
- update package-local release instructions and contract fixtures;
- run the drift checker before returning.

The script fails closed on missing expected occurrences, unexpected extra occurrences, a dirty lockfile after frozen install, or a version already present in npm.

## Validation Pipeline

### Level 1: Static Integrity

- stable SemVer and monotonic version checks;
- runtime manifest/constant/dependency/lockfile agreement;
- exact platform package availability;
- no unexpected dependency or lifecycle-script additions in the upgraded package graph;
- secret scan and generated-artifact exclusion;
- AgentRoam seven-package version consistency.

### Level 2: Focused Runtime Contracts

Each Agent owns a test command and capability matrix. Tests cover every capability implemented by its adapter, including workspace/session discovery, history conversion, create, resume, streaming, steering, abort, images, permissions, goals, fork/archive where supported, and runtime health/version reporting.

Focused tests run before AI repair and after every repair attempt. A capability removed by upstream cannot be silently deleted from AgentRoam to make the suite green; removal requires an explicit compatibility decision and is outside auto-merge scope.

### Level 3: Repository Regression

- Core, CLI, Desktop, Server, WebApp, and SDK type checks;
- affected unit and integration suites;
- production WebApp and Server builds;
- `pack:cli:all` plus all existing tarball audits;
- macOS arm64 and Windows x64 clean-install verification using the exact candidate artifacts.

### Level 4: Authenticated Real-Runtime Smoke

Dedicated CI test accounts execute real, minimal-cost turns in isolated temporary home, runtime, and data directories. No personal `~/.codex`, `~/.claude`, or OpenCode state is mounted.

For each Agent, smoke verifies:

- runtime version and protocol handshake;
- create a session in a temporary workspace;
- receive streamed reasoning/text and a terminal event;
- resume the same session for a second turn;
- abort a deliberately long turn;
- exercise one safe tool call and its permission path;
- read the resulting session through AgentRoam;
- clean the temporary workspace and session data.

Provider credentials live in separate GitHub environment secrets. They are injected only into smoke jobs and never into build or AI-repair jobs. Logs redact environment values and response headers; test prompts and model outputs must not echo secrets.

## Bounded AI Repair

When focused or regression tests show a source compatibility failure, a separate repair job invokes the official `openai/codex-action@v1`. The integration follows the official OpenAI documentation at <https://learn.chatgpt.com/docs/github-action>:

- pin the action to a reviewed immutable commit corresponding to `v1`;
- use `safety-strategy: drop-sudo` on the Linux repair runner;
- use `sandbox: workspace-write`;
- run with a fixed prompt file and normalized test output;
- provide only `OPENAI_API_KEY`; never expose npm, Gitee, provider-smoke, or signing credentials;
- keep checkout credentials disabled while Codex runs;
- run Codex as the last mutating step in its job.

The repair prompt requires root-cause analysis, the smallest compatible adapter change, and regression tests. Raw PR bodies, commit messages, release notes, package scripts, and model output are not treated as trusted instructions.

Each candidate gets at most two repair attempts. Infrastructure, authentication, rate-limit, registry, or runner failures do not consume repair attempts and never trigger source edits.

### Repair Allowlist

The exact allowlist is Agent-specific, but can include only:

- `.github/agent-runtime-versions.json`;
- package manifests and `bun.lock`;
- the selected runtime manager and its tests;
- the selected runtime adapter/client and their tests;
- shared native-runtime broker/types only when an accompanying shared regression test changes;
- Server native-runtime bridge files and tests;
- deterministic version/release scripts and their tests;
- package-local release instructions updated mechanically by the version script.

The gate rejects changes to renderer/UI code, authentication, WebAuthn, pairing, tunnel/relay code, credential handling, unrelated Customer Agent logic, workflow permissions, repository settings, binaries, archives, generated builds, and files outside the allowlist. Passing tests cannot override a path-gate failure.

## Pull Request and Merge Flow

Automation creates `chore/upgrade-<agent>-<version>` from the current default branch and opens a PR containing machine-readable old/new versions and validation status. The workflow uses its own fixed metadata rather than user-editable PR content for later steps.

The PR becomes auto-mergeable only when:

- the deterministic drift checker passes;
- the diff path gate passes;
- no forbidden file or dependency script changed;
- focused contracts, repository regression, both platform installs, and authenticated smoke all pass;
- the candidate branch still contains the current default branch and retains its reserved AgentRoam version;
- the two-attempt repair limit has not been exceeded.

The trusted `workflow_run` handler on the default branch performs the merge after successful candidate checks, obtains the exact merge commit, and starts a no-secret rebuild inside the same workflow run. It does not rely on a new workflow triggered by the repository `GITHUB_TOKEN`, because such pushes may not emit follow-on workflow events. The publish job receives only audited artifacts from that rebuild and never checks out or executes candidate source while npm or Gitee credentials are present.

## Preview Publication

The existing release order remains authoritative:

1. publish six platform packages;
2. publish the universal `agentroam` launcher last;
3. use the official npm registry, public access, `preview` dist-tag, and the configured CI authentication mode;
4. poll npm until every exact version and the `preview` tags are visible;
5. download all seven packages through an empty cache and compare SHA-256 with the validated CI artifacts;
6. run `npx agentroam@preview doctor` and clean-install smoke on macOS and Windows;
7. push the exact source commit and version tag to Gitee, then create the Gitee Release with installers and `SHA256SUMS`.

The npm and Gitee jobs use protected GitHub environments without required manual reviewers. Secrets are scoped only to their jobs. Credential values never appear in repository URLs, command arguments printed to logs, artifacts, summaries, or AI context.

## Soak and Promotion

The candidate tracking issue records `preview_started_at`. A scheduled promotion workflow checks the active candidate hourly. Every check installs the exact candidate version from the official registry with an empty cache and repeats packaging metadata validation plus authenticated real-runtime smoke on macOS and Windows.

The candidate is promoted after at least 24 hours only if:

- every scheduled check completed successfully;
- at least one successful check occurred in each rolling six-hour window;
- the final check is less than two hours old;
- all seven npm packages still point `preview` to the candidate;
- no `promotion-hold` label exists;
- no newer candidate exists.

Promotion moves all seven `latest` dist-tags to the already published candidate version. It does not republish or mutate tarballs. The workflow verifies exact dist-tags, closes the tracking issue, and lets the next queued Agent upgrade start.

There is no user telemetry in this design. The 24-hour result proves repeated clean installation and authenticated runtime behavior on CI, not absence of failures on every user machine.

## Failure and Rollback

- Detection or infrastructure failure: open/update the tracking issue, retry on the next schedule, and leave all tags unchanged.
- Compatibility failure after two AI repairs: keep the PR and logs for diagnosis, label it `needs-human`, close the candidate state, and leave the installed release unchanged.
- Partial npm publication: never publish the launcher until all platform packages exist; resume idempotently using exact registry state.
- Preview soak failure: move all seven `preview` tags back to the previous known-good version, label the candidate failed, and keep immutable packages for audit.
- Post-promotion failure: move all seven `latest` tags back to the previous known-good version. Never use npm unpublish as rollback.
- Gitee synchronization failure after npm publication: do not roll back a healthy npm candidate; retry Gitee synchronization and block `latest` promotion until both release surfaces agree.

## Workflow Layout

- `.github/workflows/agent-runtime-upgrade.yml`: daily/manual discovery, serialization, deterministic update, branch creation, and PR creation. It has repository write permission but no publish or provider credentials.
- `.github/workflows/agent-runtime-candidate-check.yml`: PR-triggered focused/full validation, macOS/Windows package checks, and authenticated smoke. Candidate code receives only its provider-specific smoke credential and never receives publish credentials.
- `.github/workflows/agent-runtime-repair.yml`: default-branch `workflow_run` handler for failed candidate checks. It invokes bounded Codex repair without publish or provider credentials, enforces the diff allowlist, and pushes the next repair attempt.
- `.github/workflows/agent-runtime-publish.yml`: default-branch `workflow_run` handler for successful candidate checks. It revalidates the PR and head SHA, auto-merges, rebuilds the exact merge commit without secrets, then passes audited artifacts to isolated npm and Gitee publication jobs.
- `.github/workflows/agent-runtime-soak.yml`: hourly active-candidate lookup, macOS/Windows exact-version smoke, rollback, and `latest` promotion.
- `.github/codex/prompts/repair-agent-runtime.md`: fixed repair contract with scope and test obligations.
- `scripts/agent-runtime-upgrade.mjs`: detect/apply/check/version-reservation commands.
- `scripts/check-agent-runtime-diff.mjs`: Agent-specific path and semantic diff gate.
- `scripts/verify-agent-runtime-live.mjs`: isolated authenticated smoke entrypoint.
- `scripts/publish-agentroam-release.mjs`: idempotent publish, registry verification, Gitee synchronization, dist-tag promotion, and rollback primitives.

## Notifications and Audit

GitHub issues and workflow summaries are the primary notification surface. Success, repair, failure, rollback, hold, and promotion events include Agent/runtime versions, AgentRoam version, commit, test run URLs, and artifact hashes. Notifications never include prompts, model responses, tokens, or raw environment dumps.

Every external mutation is idempotent and auditable: PR, merge commit, npm versions/tags, Gitee tag/Release, candidate issue, hourly smoke runs, and promotion/rollback comments form the release ledger.

## Required Repository Configuration

- GitHub Actions enabled on a mirror that receives and can merge the default branch.
- Workflow permissions: `contents: write`, `pull-requests: write`, and `issues: write` only in orchestration jobs.
- `OPENAI_API_KEY` for the isolated Codex repair job.
- dedicated Codex, Claude, and OpenCode smoke credentials in separate environments.
- npm publish credential or trusted-publishing configuration.
- Gitee synchronization and Release credential.
- branch protection requiring candidate checks while allowing the automation identity to auto-merge after they pass.

Missing credentials or repository settings cause a fail-closed issue with setup instructions; they never downgrade validation or publish partially.

## Verification of the Automation

Before enabling the schedule:

1. Unit-test detection, strict SemVer filtering, manifest drift, version application, version reservation, path gates, publish order, visibility polling, promotion, and rollback.
2. Run a no-change detection against all three registries.
3. Use fixture registry metadata to simulate one upgrade per Agent and simultaneous upgrades.
4. Force a focused test failure and confirm one bounded Codex repair PR changes only allowed paths.
5. Force a forbidden-file edit and confirm auto-merge is blocked despite green tests.
6. Publish to an isolated npm test package set or execute publish dry-run, then verify partial-publish recovery.
7. Exercise accelerated soak timing in a test workflow, including hold, failed hourly smoke, preview rollback, and ordered latest promotion.
8. Enable the daily and hourly schedules only after the dry-run ledger is complete.

## Success Criteria

- A newly published stable Agent version is detected without human action.
- Exactly one independent upgrade candidate is active at a time.
- Compatible upgrades reach `preview` automatically after macOS, Windows, and authenticated real-runtime validation.
- Protocol drift gets at most two scoped AI repair attempts with required tests.
- Forbidden changes, missing credentials, or incomplete validation cannot auto-merge or publish.
- A green candidate is promoted to `latest` after a verifiable 24-hour soak.
- A failed candidate restores all relevant dist-tags to the prior known-good release without unpublishing artifacts.
- npm, GitHub, and Gitee state can be traced to one exact commit and artifact hash set.
