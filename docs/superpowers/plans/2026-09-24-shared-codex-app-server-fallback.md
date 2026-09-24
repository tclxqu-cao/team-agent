# Shared Codex App Server Fallback Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every default AgentRoam Codex app-server client prefer the shared daemon/proxy transport and automatically fall back to the existing standalone stdio transport.

**Architecture:** A focused launcher module exposes ordered shared and standalone launch attempts, and a proxy adapter performs WebSocket framing over the proxy byte stream. `CodexAppServerClient` owns the initialization-aware attempt loop so a proxy is accepted only after WebSocket upgrade and JSON-RPC initialization, while startup failures remain internal when fallback succeeds.

**Tech Stack:** TypeScript, Node.js `child_process` and streams, `ws`, JSON-RPC over WebSocket or JSONL stdio, Vitest, Bun.

## Global Constraints

- Preserve `codex app-server --stdio` as the standalone fallback.
- Default startup order is `codex app-server daemon start`, then `codex app-server proxy`, then standalone only after a shared-path failure.
- Shared proxy traffic uses a standard WebSocket HTTP Upgrade and one JSON-RPC message per text frame; standalone traffic remains JSONL.
- Do not detect support from a hard-coded Codex version.
- Do not switch transport during an established connection or active turn.
- `dispose()` must not stop the machine-level daemon.
- Preserve unrelated working-tree changes and do not change runtime adapter call sites that already construct `CodexAppServerClient`.

---

### Task 1: Add Codex App Server Launch Strategies

**Files:**
- Create: `packages/native-runtime/src/agent-runtime/codex-app-server-launcher.ts`

**Interfaces:**
- Consumes: `typeof spawn`, an executable string, normalized `NodeJS.ProcessEnv`, and a startup timeout.
- Produces: `CodexAppServerLaunchMode`, `CodexAppServerLaunchAttempt`, `CodexAppServerLauncher`, `SharedCodexAppServerLauncher`, `StandaloneCodexAppServerLauncher`, and `FallbackCodexAppServerLauncher`.

- [x] **Step 1: Define the launch-attempt boundary**

```ts
export type CodexAppServerLaunchMode = "shared" | "standalone";

export interface CodexAppServerLaunchAttempt {
  readonly mode: CodexAppServerLaunchMode;
  launch(): Promise<ChildProcessWithoutNullStreams>;
}

export interface CodexAppServerLauncher {
  attempts(): readonly CodexAppServerLaunchAttempt[];
}
```

- [x] **Step 2: Implement standalone and shared launchers**

`StandaloneCodexAppServerLauncher.launch()` spawns:

```ts
spawnProcess(executable, ["app-server", "--stdio"], {
  env: environment,
  stdio: ["pipe", "pipe", "pipe"],
});
```

`SharedCodexAppServerLauncher.launch()` first awaits a bounded one-shot command:

```ts
await runCommandToCompletion(
  spawnProcess,
  executable,
  ["app-server", "daemon", "start"],
  environment,
  startupTimeoutMs,
);
return spawnProcess(executable, ["app-server", "proxy"], {
  env: environment,
  stdio: ["pipe", "pipe", "pipe"],
});
```

The one-shot helper rejects on spawn error, non-zero exit, or timeout; includes a bounded stderr excerpt in non-zero errors; and terminates only the daemon-start command on timeout.

- [x] **Step 3: Implement ordered fallback attempts**

```ts
export class FallbackCodexAppServerLauncher implements CodexAppServerLauncher {
  constructor(
    private readonly shared: CodexAppServerLaunchAttempt,
    private readonly standalone: CodexAppServerLaunchAttempt,
  ) {}

  attempts(): readonly CodexAppServerLaunchAttempt[] {
    return [this.shared, this.standalone];
  }
}
```

### Task 2: Make Client Startup Initialization-Aware

**Files:**
- Create: `packages/native-runtime/src/agent-runtime/codex-app-server-websocket.ts`
- Modify: `packages/native-runtime/src/agent-runtime/codex-app-server-client.ts`
- Modify: `packages/native-runtime/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `CodexAppServerLauncher.attempts()` from Task 1 and the repository-standard `ws` package.
- Produces: default shared-first behavior through the existing `CodexAppServerClient` public API, a WebSocket adapter over proxy stdin/stdout, plus optional `launcher` and `startupTimeoutMs` constructor dependencies for tests and specialized callers.

- [x] **Step 1: Construct the default fallback launcher**

Extend `CodexAppServerClientOptions` with:

```ts
launcher?: CodexAppServerLauncher;
startupTimeoutMs?: number;
```

When no launcher is supplied, normalize the environment once and compose:

```ts
new FallbackCodexAppServerLauncher(
  new SharedCodexAppServerLauncher(commonLaunchOptions),
  new StandaloneCodexAppServerLauncher(commonLaunchOptions),
)
```

- [x] **Step 2: Replace single-process startup with an attempt loop**

For each launch attempt:

```ts
for (const attempt of this.launcher.attempts()) {
  try {
    const child = await attempt.launch();
    await this.attachProcess(child, attempt.mode);
    await this.initialize();
    this.processReady = true;
    return;
  } catch (error) {
    failures.push({ mode: attempt.mode, error: toError(error) });
    await this.stop();
  }
}
throw failures.at(-1)!.error;
```

Keep `initialize` and `initialized` in the client because JSON-RPC readiness determines whether fallback is required.

- [x] **Step 3: Add WebSocket framing for shared proxy connections**

Wrap the proxy's stdout/stdin as a duplex socket and connect `ws` with a custom `createConnection`:

```ts
const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
return new WebSocket("ws://localhost/", {
  createConnection: (() => socket) as never,
  handshakeTimeout: startupTimeoutMs,
  perMessageDeflate: false,
});
```

Send shared JSON-RPC messages as WebSocket text frames and parse one JSON-RPC object per received text frame. Keep newline-delimited JSON only for standalone mode.

- [x] **Step 4: Separate startup failure from established-process exit**

Track whether the current child completed initialization. Child errors/exits always reject pending startup requests, but call registered `onExit` listeners only when that exact child was established. Ignore late exit events from a candidate already detached during cleanup.

`handleStdout` also verifies the emitting child is still current so output from a discarded proxy cannot enter the next attempt's parser buffer.

- [x] **Step 5: Preserve lifecycle semantics**

`restart()` and lazy startup both rerun the full ordered attempt list. `dispose()` and attempt cleanup terminate only the currently owned proxy or standalone process and never issue `daemon stop`.

### Task 3: Cover Shared Success And Fallback Behavior

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts`

**Interfaces:**
- Consumes: `CodexAppServerClient`, launcher injection, and the fake child-process helper.
- Produces: regression coverage for command order, compatibility fallback, cleanup, listener semantics, restart re-probing, and unchanged JSON-RPC behavior.

- [x] **Step 1: Extend fake-process helpers**

Add helpers that create independent daemon, proxy, and standalone fake children; perform the proxy WebSocket HTTP Upgrade; encode/decode WebSocket text frames; parse standalone JSONL; complete daemon commands with a selected exit/error result; and reply to `initialize` with success or a JSON-RPC error.

- [x] **Step 2: Preserve existing standalone protocol tests through explicit launcher injection**

Use a one-attempt test launcher:

```ts
const launcher: CodexAppServerLauncher = {
  attempts: () => [{ mode: "standalone", launch: async () => child }],
};
```

Keep assertions for fragmented JSON, request correlation, normalized environment behavior, notifications, and pending-request rejection after established exit.

- [x] **Step 3: Test default shared startup**

Use an injected spawn function and assert the ordered argument arrays are exactly:

```ts
[
  ["app-server", "daemon", "start"],
  ["app-server", "proxy"],
]
```

Assert `initialize` completes through the proxy and `dispose()` kills the proxy without spawning a daemon-stop command.

- [x] **Step 4: Test compatibility and readiness fallback**

Cover daemon command error/non-zero exit and proxy `initialize` error. Assert each case next spawns `["app-server", "--stdio"]`, kills a failed proxy when present, resolves the caller through standalone, and does not notify `onExit` listeners.

- [x] **Step 5: Test retry and terminal failure semantics**

Make the first shared attempt fail and standalone succeed, then call `restart()` with a successful second shared attempt. Assert daemon/proxy are retried and standalone is not permanently selected. Add a both-attempts-fail case that rejects with a runtime/protocol error.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts`

Expected: PASS

Run: `bun run --cwd packages/native-runtime build`

Expected: PASS

If a test or build fails, fix the implementation or test and rerun both commands until they pass. Report the commands and results in the final response.
