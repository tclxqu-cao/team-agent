# Native Agent Runtime Version Upgrade Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade customer-agent's Claude Agent SDK and the host Codex CLI to the latest stable versions, then restart and verify the `:3000` production instance.

**Architecture:** Preserve the existing integrations: Claude continues through `@anthropic-ai/claude-agent-sdk`, while Codex continues through the managed standalone CLI's `app-server --stdio` JSON-RPC process. Dependency manifests and the Bun lockfile carry the Claude upgrade. When the standalone download endpoint is unavailable, use the complete native layout shipped in the official npm platform package to populate the managed standalone release.

**Tech Stack:** TypeScript, Bun workspaces, Vitest, Claude Agent SDK, Codex CLI app-server, Next.js

## Global Constraints

- Claude Agent SDK target: `0.3.259`, bundling Claude Code `2.1.259`.
- Codex CLI stable target: `0.153.0`.
- Do not add `@openai/codex-sdk` or change the existing app-server protocol integration.
- Preserve all unrelated working-tree changes.
- Restart `:3000` only after dependency and runtime verification passes.

---

### Task 1: Claude Agent SDK Dependency

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/server/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: existing imports from `@anthropic-ai/claude-agent-sdk` in `packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`
- Produces: workspace resolution of `@anthropic-ai/claude-agent-sdk@0.3.259` and matching platform packages

- [x] **Step 1: Update both workspace dependency ranges**

Change `"@anthropic-ai/claude-agent-sdk": "^0.3.251"` to `"@anthropic-ai/claude-agent-sdk": "^0.3.259"` in the desktop and server manifests.

- [x] **Step 2: Regenerate the Bun lockfile**

Run: `bun install`

Confirm: `bun.lock` resolves the main package and all optional platform packages at `0.3.259` without changing the runtime adapter source.

### Task 2: Codex Runtime

**Files:**
- No repository files modified
- Stage from: `/Users/caoqu/.local/lib/node_modules/@openai/codex`
- Update: `/Users/caoqu/.codex/packages/standalone/releases/0.153.0-aarch64-apple-darwin`
- Update: `/Users/caoqu/.codex/packages/standalone/current`
- Update: `/Users/caoqu/.local/bin/codex`

**Interfaces:**
- Consumes: `codex app-server --stdio` launched by `CodexAppServerClient`
- Produces: `codex --version` reporting `codex-cli 0.153.0`

- [x] **Step 1: Run the official standalone installer**

The standalone installer timed out connecting to `chatgpt.com`. The supported npm distribution was installed as a staging source with `npm install -g --prefix /Users/caoqu/.local @openai/codex@0.153.0 --registry=https://registry.npmjs.org/ --force`; its complete `vendor/aarch64-apple-darwin` layout was copied into the new managed standalone release, and the `current` and local CLI symlinks were switched atomically. The previous standalone releases remain available for rollback.

- [x] **Step 2: Verify the selected executable**

Run: `command -v codex && codex --version`

Confirm: `/Users/caoqu/.local/bin/codex` points to `/Users/caoqu/.codex/packages/standalone/current/bin/codex`; the CLI, managed manifest, and restarted shared daemon all report `0.153.0`.

### Task 3: Production Restart

**Files:**
- No source files modified
- Rebuild and restart the launchd-managed `:3000` instance through the project release workflow

**Interfaces:**
- Consumes: verified workspace dependencies and standalone Codex executable
- Produces: healthy production endpoints and a new app-server child process using Codex `0.153.0`

- [x] **Step 1: Build and restart the production instance**

Follow the `customer-agent-webapp-release` skill, including its Node 22 and `better-sqlite3` ABI handling.

- [x] **Step 2: Verify runtime health and executable identity**

Confirm the web endpoint and runtime health endpoint return HTTP 200, then inspect the new app-server process and verify it directly executes `/Users/caoqu/.codex/packages/standalone/releases/0.153.0-aarch64-apple-darwin/bin/codex`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/main/agent-runtime/claude-runtime-adapter.test.ts packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`

Run: `bunx tsc -p packages/desktop/tsconfig.json --noEmit`

Run: `bun run --cwd packages/server build`

Expected: all focused tests pass, desktop type checking passes, and the server production build succeeds. Fix any dependency-compatibility failure and rerun the failed command until it passes.
