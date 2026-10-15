# Codex Desktop First Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect AgentRoam to an available official Desktop app-server before trying shared daemon and standalone.

**Architecture:** Discover an existing local Desktop endpoint without changing Desktop startup. A borrowed WebSocket connection has no owned child process; cleanup closes only the connection. Fallback ends after initialization, so business RPC failures never replay messages.

**Tech Stack:** TypeScript, Node 22, ws, Vitest.

## Global Constraints

- Preserve desktop other active sessions: no backend kill, writer-lock deletion, stdio injection, or Desktop restart.
- Priority: desktop → shared → standalone, probed again on a new connection.
- Current Desktop stdio-only transport is unavailable to external clients; select shared normally.
- Preserve existing untracked files; do not change project docs, commit, push, deploy, or replay business messages.

### Task 1: Endpoint discovery and launcher order

**Files:** Create `packages/native-runtime/src/agent-runtime/codex-desktop-endpoint.ts` and its test; modify `codex-app-server-launcher.ts`.

**Interfaces:**

```ts
export interface CodexDesktopEndpoint { webSocketUrl: string }
export type CodexDesktopEndpointResolver = () => Promise<CodexDesktopEndpoint | null>;
// launch() returns an owned child OR a borrowed endpoint.
```

- [x] Identify a direct app-server child of Codex.app/ChatGPT.app using bounded process inspection on macOS. Ignore daemon/proxy/stdio-only processes. For Unix listeners inspect named sockets, never anonymous socketpairs. Accept `AGENT_CODEX_DESKTOP_WS_URL` as an explicit local endpoint override.
- [x] Put the Desktop attempt before existing shared/standalone attempts, retaining old launcher test doubles.
- [x] Test parent identity, named Unix/TCP endpoints, stdio/daemon exclusion, explicit overrides and discovery errors.

### Task 2: Borrowed transport lifecycle

**Files:** Modify `codex-app-server-client.ts` and `codex-app-server-client.test.ts`; create `codex-app-server-desktop.test.ts`.

**Interfaces:**

```ts
// Client option used for deterministic discovery tests.
resolveDesktopEndpoint?: CodexDesktopEndpointResolver;
// An initialized direct WebSocket is ready without a child PID.
// stop() terminates the socket and only this.process, never a discovered PID.
```

- [x] Reuse WebSocket RPC handling for borrowed Desktop sockets and owned shared proxies. Bound initialization by the startup timeout. Keep business requests on the initialized backend.
- [x] Cancel pending startup on disposal/restart without leaking a subsequently launched child or starting a fallback after disposal.
- [x] Keep existing fake-spawn tests offline by injecting a null Desktop resolver.
- [x] Add local WebSocket tests: Desktop skips fallback; unavailable/handshake/initialization failures fall back; business writer errors do not replay; one client's dispose/restart/failure leaves another client's pending work running; reconnect re-probes Desktop.

```ts
expect(client.mode).toBe("desktop");
expect(spawnProcess).not.toHaveBeenCalled();
await client.dispose();
await expect(otherClient.request("thread/list", {})).resolves.toEqual({ data: [] });
```

## Final Unit Test Verification

- [x] Run affected tests after implementation:

```sh
PATH=/opt/homebrew/opt/node@22/bin:/Users/caoqu/.bun/bin:$PATH bunx vitest run packages/native-runtime/src/agent-runtime/codex-desktop-endpoint.test.ts packages/native-runtime/src/agent-runtime/codex-app-server-desktop.test.ts packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts
```

Expected: PASS. Fix failures before reporting. Build `@agent/native-runtime`; perform an isolated initialize + thread/loaded/list live smoke with no business input and no service restart. Review diff and stage reusable findings in wiki `_raw/`.

## Verification Results

- 2026-10-09: four focused test files, 138 passed. Desktop-only recheck after the test helper type repair: 15 passed.
- `cd packages/native-runtime && PATH=/opt/homebrew/opt/node@22/bin:/Users/caoqu/.bun/bin:$PATH bun run build`: PASS (bundle and TypeScript declarations).
- Node 22 isolated initialize + thread/loaded/list smoke: Desktop discovery returned null; selected shared; daemon PID 38527 and Desktop PID 31286 kept their startup identities; owned proxy PID 33474 exited on disposal. No business inputs were submitted.
- Direct Bun source smoke failed shared transport and fell back to standalone. Node-target runtime passed; Bun proxy compatibility is outside this change.
- No service deployment, Desktop restart, commit, push or project docs write. Findings staged in wiki `_raw/2026-10-09-codex-desktop-first-transport.md`.

- Final discovery ownership and startup-cancellation changes: `bunx vitest run packages/native-runtime/src/agent-runtime/codex-desktop-endpoint.test.ts packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts` passed 38 tests; final native-runtime build passed. The four relevant files now contain 140 passing cases.
- Prepared `scripts/start-codex-desktop-shared.sh`: Desktop connects to shared daemon through `CODEX_APP_SERVER_WS_URL` on its next launch. `bash -n`, `--dry-run`, and live running-Desktop refusal passed. No actual Desktop launch or restart was performed.
- Suggested project docs sync: `docs/agent-integration-and-remote-control.md`, connection priority, local endpoint override and Desktop-to-daemon launch directions. No project docs modified.

## Task 3: Package the official Desktop launch command

User chose to preserve running Desktop by default and provide an explicit switch command.

- [x] Ship the launcher under `packages/cli/install/start-codex-desktop-shared.sh`; root script delegates to it.
- [x] Add `codex-desktop`, `--dry-run`, explicit `--restart` to CLI argument parsing, help and dispatch; macOS service install prints the command.
- [x] Reuse matching installed service Codex path/home with explicit environment taking precedence; dry run never installs a runtime.
- [x] Check the Desktop override capability and daemon readiness before an opt-in quit; wait for graceful exit without forced termination or second instance. No actual Desktop restart was performed.
- [x] Run focused CLI tests: `PATH=/opt/homebrew/opt/node@22/bin:/Users/caoqu/.bun/bin:$PATH bunx vitest run packages/cli/src/args.test.ts packages/cli/src/codex-desktop-command.test.ts packages/cli/src/service/service-command.test.ts packages/cli/src/install-script-contract.test.ts`. Final CLI coverage: 45 passed, 1 skipped; 12 Desktop command tests passed after fixture and old-version guard changes.
- [x] `cd packages/cli && npm run build`: PASS. `npm pack --dry-run --json --ignore-scripts`: required command and script included.
- [x] Actual built CLI `node packages/cli/bin/agentroam.mjs codex-desktop --restart --dry-run`: PASS, no runtime switch.
- [x] Capture CLI distribution and user preference in wiki `_raw/2026-10-09-agentroam-cli-desktop-shared-launch.md`.
