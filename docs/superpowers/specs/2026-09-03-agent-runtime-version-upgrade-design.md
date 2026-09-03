# Native Agent Runtime Version Upgrade Design

**Date:** 2026-09-03

## Goal

Update the native Claude Code and Codex integrations to their latest stable releases while preserving the existing runtime architecture and behavior.

## Scope

- Update `@anthropic-ai/claude-agent-sdk` from `0.3.251` to `0.3.259` in the desktop and server packages and regenerate `bun.lock`.
- Keep the Codex app-server integration. Do not add `@openai/codex-sdk` because the application already talks directly to `codex app-server` over JSON-RPC.
- Update the Codex CLI from `0.152.0` to `0.153.0` using the official standalone installer, or the official npm distribution if the installer endpoint is unreachable.
- Restart the `:3000` production instance after verification so its long-lived app-server child uses the new Codex executable.

## Compatibility

Claude Agent SDK `0.3.259` retains the Node.js and peer dependency requirements of `0.3.251`. The APIs used by the project remain present: `query`, `skills: "all"`, `forwardSubagentText`, `agentProgressSummaries`, and the `active_goal` event. The SDK upgrade also changes its bundled Claude Code runtime from `2.1.251` to `2.1.259`.

Codex `0.153.0` continues to expose `app-server --stdio`, so no application code or protocol migration is planned. If the standalone endpoint is unreachable, the official npm platform package can supply the same complete native layout (`bin`, resources, bundled path tools, and package manifest) for a managed standalone release. The final customer-agent process should still launch the standalone native binary directly, avoiding a wrapper PID that would complicate process ownership checks.

## Verification

- Confirm the manifest and lockfile resolve Claude Agent SDK `0.3.259` and its platform packages.
- Run the focused Claude and Codex runtime adapter tests.
- Run desktop and server type checks/builds required by the affected packages.
- Confirm `codex --version`, the managed standalone manifest, the shared agents daemon, and customer-agent's spawned app-server all report `0.153.0`.
- Restart `:3000`, verify its health endpoints, and confirm the new app-server process loads the `0.153.0` executable.

## Failure Handling

If dependency validation fails, keep the existing application code unchanged and report the incompatibility. If the production restart fails, use the existing release workflow's rollback procedure and preserve the last known-good build.
