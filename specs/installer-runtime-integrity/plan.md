# Installer runtime integrity implementation plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reject incomplete AgentRoam installations, repair incomplete cached launchers, and preserve the previous installation when runtime installation fails.

**Architecture:** Both standalone installers embed the same Node.js validator. The validator reads the installed launcher's exact runtime dependency, validates its manifest and native files, and loads SQLite and PTY. Installation happens in a temporary prefix; an invalid runtime is explicitly reinstalled as a required dependency before the staged launcher is activated.

**Tech Stack:** POSIX shell, PowerShell, Node.js, Vitest.

## Global constraints

- Node.js floor: `22.22.0`; runtime manifest schema: `2`.
- Runtime version comes from `agentroam/package.json.optionalDependencies`, independently of the launcher version.
- Standalone scripts work with already published launchers and require no extra downloaded helper.
- Required runtime failures abort before wrapper or service updates. Optional diagnostics can still warn.
- Preserve unrelated local files and application data. Commit and push only after explicit user authorization; npm publishing and project docs updates remain outside this task.

## Task 1: Embed runtime validation in both installers

**Files:** `packages/cli/install/install-agentroam.sh`, `packages/cli/install/install-agentroam.ps1`.

**Interfaces:** Node validator accepts `(prefix, launcherVersion, minimumNodeVersion, target, mode)`; `spec` prints the exact runtime spec; `verify` returns success only for a complete compatible runtime.

- [x] Read the launcher manifest and resolve the exact platform package:

```js
const version = launcher.optionalDependencies[packageName];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Runtime dependency must use an exact version");
```

- [x] Validate the runtime package/manifest versions, target, schema, minimum Node version, server entry, build marker, native file hashes, SQLite query, and PTY module load. Keep the embedded Node code identical in both scripts.

## Task 2: Repair staged installations before activation

**Files:** Both installers above.

**Interfaces:** Existing launcher checks consume `verify`; staged repair consumes `spec` and reruns `verify` before activation.

- [x] Treat a cached launcher with a missing or invalid runtime as incomplete.
- [x] After the initial npm install, explicitly install the exact runtime if validation fails; remove only the invalid runtime in the temporary prefix first:

```sh
run_with_progress "正在安装必需的运行组件" "$NODE_BIN" "$NPM_CLI" install --save-exact --include=optional --no-audit --no-fund --registry "$NPM_REGISTRY" --prefix "$TEMP_ROOT" "$runtime_spec"
launcher_check "$TEMP_ROOT" verify
```

- [x] Activate only after validation, using a backup rename and rollback if the staged rename fails. Put the Windows launcher lock outside the replaceable directory.

## Task 3: Add focused installer regressions

**Files:** `packages/cli/src/installer-runtime-integrity.test.ts`, existing installer contract tests if their terminology needs clarification.

- [x] Execute the embedded validator for both platform targets; cover exact-version reuse, missing runtime, wrong manifest, native corruption, and native module loading failures.
- [x] Execute the actual shell installation flow with a fake npm/CLI and isolated prefixes; cover skipped optional runtime, required-install failure, cached incomplete repair, healthy cache reuse, and validation failure after npm success.
- [x] Check failed installs preserve the old launcher and wrapper, retain the npm error, skip doctor/service registration, and clean up temporary files/locks.

## Final unit test verification

- [x] Run `node node_modules/vitest/vitest.mjs run packages/cli/src/installer-runtime-integrity.test.ts packages/cli/src/install-script-contract.test.ts packages/cli/src/installer-progress.test.ts packages/cli/src/platform-packages.test.ts packages/cli/src/native-runtime.test.ts`.
- [x] Run `sh -n packages/cli/install/install-agentroam.sh`, `node scripts/generate-node-runtime-policy.mjs --check`, and `git diff --check`.
- [x] Run the embedded validator against the restored local installation without reinstalling or restarting its service.
- [x] Report Windows execution as unverified locally if PowerShell remains unavailable; the Windows embedded validator is exercised by the cross-platform unit tests.

## Verification results (2026-10-12)

- All five affected test files passed: 51 passed, 1 skipped. The skip is the existing Windows NVM discovery test on macOS.
- The new runtime integrity suite has 32 passing tests, including a complete fresh install that performs only one npm installation.
- Shell syntax, generated Node runtime policy, and Git diff whitespace checks passed.
- The embedded validator accepted the restored local launcher `0.2.0-preview.40` and its exact reused runtime `0.2.0-preview.39`; both `spec` and `verify` exited 0. This check did not reinstall or restart the local service.
- Both platform validators and Node stdin execution passed fixture tests. PowerShell is unavailable on this host, so the complete Windows installer and Windows native binaries were not executed locally; the existing Windows bootstrap smoke remains the full-platform validation path.
- Validation completed before Git delivery. No npm release or service deployment was performed.
