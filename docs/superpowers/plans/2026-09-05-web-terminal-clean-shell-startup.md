# Web Terminal Clean Shell Startup Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace timed terminal bootstrap input with managed shell startup integration and show a stable loading state until the shell explicitly reports readiness.

**Architecture:** A new server helper owns versioned zsh startup files, PowerShell startup arguments, and streaming Ready-marker detection. `ws-server.mjs` owns per-session readiness, sends `term:ready`, and delays each validated `initialCommand` until readiness; `TerminalPane.tsx` consumes the response/event and renders the loading or timeout state without unmounting xterm.

**Tech Stack:** Node.js ESM, node-pty, zsh/PowerShell startup contracts, WebSocket JSON events, React 18, xterm.js, Vitest.

## Global Constraints

- Keep the existing zsh `preexec + precmd + exitCode` OSC 633 protocol, prepend ordering, successful-command filtering, and command deduplication.
- Keep a normal `+` terminal's default working directory at `$HOME` unless the caller supplies `cwd`.
- Use a managed zsh directory with mode `0700`, startup files with mode `0600`, and shell-quote every generated source path.
- Never write zsh or PowerShell integration source through `pty.write` during startup.
- Emit an invisible, versioned Ready marker; reveal the PTY after eight seconds if readiness has not arrived.
- Do not add bash/fish history integration, durable readiness state, or production deployment work.

---

### Task 1: Managed Shell Integration Helper

**Files:**
- Create: `packages/server/shell-integration.mjs`
- Create: `packages/server/shell-integration.d.mts`
- Create: `packages/server/lib/shell-integration.test.ts`

**Interfaces:**
- Consumes: `shell`, `serverBaseDir`, `homeDir`, `env`, and optional `command` values from the terminal launcher.
- Produces: `createTerminalShellLaunch(options): { args: string[]; env: NodeJS.ProcessEnv; waitsForReady: boolean }`, `TERMINAL_READY_MARKER`, and `consumeTerminalReadyMarker(tail, data): { ready: boolean; tail: string }`.

- [x] **Step 1: Implement quoting and versioned zsh startup-file generation**

Create a helper that resolves the original zsh directory from `env.ZDOTDIR || homeDir`, rejects self-sourcing, writes `.zshenv`, `.zprofile`, `.zshrc`, and `.zlogin` into a versioned temporary directory, applies `0700`/`0600`, and renames the completed directory into place.

```js
export const TERMINAL_READY_MARKER = "\x1b]633;AgentRoamReady;1\x07";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sourceIfReadable(file) {
  const quoted = shellQuote(file);
  return `[[ -r ${quoted} ]] && source ${quoted}`;
}
```

The generated `.zshrc` must include both hook definitions and these exact prepend contracts:

```zsh
precmd_functions=(__ca_hist_precmd $precmd_functions)
preexec_functions=(__ca_hist_preexec $preexec_functions)
```

- [x] **Step 2: Build platform-specific launch arguments**

For zsh, return the existing login arguments and an environment copy whose `ZDOTDIR` points to the managed directory. For PowerShell interactive sessions, return `-NoLogo -NoExit -Command <integration>` where the integration installs OSC 7 prompt reporting, clears the host, and prints `TERMINAL_READY_MARKER`; unsupported shells return their current login arguments and `waitsForReady: false`.

```js
export function createTerminalShellLaunch({ shell, command, serverBaseDir, homeDir, env }) {
  if (shell.endsWith("zsh")) {
    const zdotdir = ensureManagedZshDir({ serverBaseDir, homeDir, env });
    return { args: command ? ["-l", "-c", command] : ["-l"], env: { ...env, ZDOTDIR: zdotdir }, waitsForReady: true };
  }
  if (isPowerShell(shell) && !command) {
    return { args: ["-NoLogo", "-NoExit", "-Command", buildPowerShellIntegration()], env: { ...env }, waitsForReady: true };
  }
  return { args: command ? ["-l", "-c", command] : ["-l"], env: { ...env }, waitsForReady: false };
}
```

- [x] **Step 3: Implement chunk-safe Ready-marker detection**

Retain only the longest output suffix that is also a marker prefix, so every split position including a lone trailing escape byte is recognized without scanning unbounded output.

```js
export function consumeTerminalReadyMarker(tail, data) {
  const combined = tail + data;
  if (combined.includes(TERMINAL_READY_MARKER)) return { ready: true, tail: "" };
  for (let length = Math.min(combined.length, TERMINAL_READY_MARKER.length - 1); length > 0; length--) {
    const suffix = combined.slice(-length);
    if (TERMINAL_READY_MARKER.startsWith(suffix)) return { ready: false, tail: suffix };
  }
  return { ready: false, tail: "" };
}
```

- [x] **Step 4: Add focused helper tests**

Use isolated temporary directories to verify source order, single-quote escaping, original unset/custom `ZDOTDIR` restoration, self-source avoidance, file modes, hook source and prepend ordering, PowerShell `-NoExit -Command`, and every possible Ready-marker chunk split.

```ts
for (let split = 1; split < TERMINAL_READY_MARKER.length; split++) {
  const first = consumeTerminalReadyMarker("", TERMINAL_READY_MARKER.slice(0, split));
  expect(consumeTerminalReadyMarker(first.tail, TERMINAL_READY_MARKER.slice(split)).ready).toBe(true);
}
```

### Task 2: Terminal Session Readiness Lifecycle

**Files:**
- Modify: `packages/server/ws-server.mjs:18-32,188-328,483-549,574-616`
- Modify: `packages/server/lib/command-history-capture.test.ts`
- Create: `packages/server/lib/terminal-readiness-contract.test.ts`

**Interfaces:**
- Consumes: `createTerminalShellLaunch`, `consumeTerminalReadyMarker`, and `waitsForReady` from Task 1.
- Produces: `TerminalSession.ready`, `readyTail`, `readyWatchers`, `initialCommand`, `initialCommandSent`; `term:start` result field `ready: boolean`; JSON event `{ type: "term:ready", id }`.

- [x] **Step 1: Launch the PTY with the helper result**

Replace inline platform argument construction with `createTerminalShellLaunch`, pass its copied environment to `pty.spawn`, initialize readiness fields on `TerminalSession`, and remove all delayed integration writes.

```js
const launch = createTerminalShellLaunch({ shell, command, serverBaseDir, homeDir: os.homedir(), env: process.env });
const p = pty.spawn(shell, launch.args, { name: "xterm-256color", cols, rows, cwd: initialCwd, env: launch.env });
```

- [x] **Step 2: Make readiness monotonic and dispatch the initial command once**

Add `markTerminalReady(session)` and call it when the streaming parser recognizes the marker, or immediately after registration when `waitsForReady` is false.

```js
function markTerminalReady(session) {
  if (session.ready) return;
  session.ready = true;
  if (session.initialCommand && !session.initialCommandSent) {
    session.initialCommandSent = true;
    session.pty.write(`${session.initialCommand}\r`);
  }
  for (const notify of [...session.readyWatchers]) notify();
  session.readyWatchers.clear();
}
```

On process exit, clear readiness watchers together with data and cwd watchers.

- [x] **Step 3: Attach and detach connection-level Ready forwarding**

Add `readyForwards` to each connection, remove its callback in `detachTerminal`, register a forwarding callback during `term:start`, and return the current readiness value.

```js
const readyForward = () => conn.sendJson({ type: "term:ready", id });
if (!session.ready) session.readyWatchers.add(readyForward);
conn.readyForwards.set(id, readyForward);
return { sessionId: id, channelId, cols: session.size.cols, rows: session.size.rows, cwd: currentCwd, ready: session.ready };
```

Queue terminal reset and a fresh scrollback snapshot with `setImmediate` at the end of `term:start`. The RPC result is sent first, so WebSocket ordering lets a new client register its binary channel before reset and replay arrive.

- [x] **Step 4: Migrate static history assertions and add lifecycle contract tests**

Read hook source from `shell-integration.mjs` in `command-history-capture.test.ts`, while continuing to inspect `captureShellHistory` in `ws-server.mjs`. Add contract assertions proving the old 350 ms bootstrap and integration `pty.write` strings are gone, the response includes `ready`, the event is emitted, readiness watchers are detached/cleared, and `initialCommandSent` guards the write.

```ts
expect(wsServerSource).not.toContain("}, 350).unref?.()")
expect(wsServerSource).toContain('conn.sendJson({ type: "term:ready", id })');
expect(wsServerSource).toContain("initialCommandSent = true");
```

### Task 3: Delayed-zsh Real PTY Coverage

**Files:**
- Create: `packages/server/lib/shell-integration-pty.test.ts`

**Interfaces:**
- Consumes: `createTerminalShellLaunch` and `TERMINAL_READY_MARKER` from Task 1 plus `node-pty`.
- Produces: An integration-level regression test for slow zsh startup and command-history OSC output.

- [x] **Step 1: Create an isolated delayed zsh profile**

Create temporary original and server data directories. Write an original `.zshrc` that sleeps for at least 500 ms and sets a deterministic prompt, then build the managed launch using that original directory as `ZDOTDIR`.

```ts
writeFileSync(join(originalZdotdir, ".zshrc"), "sleep 0.5\nPS1='agentroam-test% '\n", { mode: 0o600 });
const launch = createTerminalShellLaunch({ shell: "/bin/zsh", serverBaseDir, homeDir: tempRoot, env: { ...process.env, ZDOTDIR: originalZdotdir } });
```

- [x] **Step 2: Verify marker timing and history output through a real PTY**

Collect PTY output, assert readiness is absent before the delay, wait for the marker, write `true\r`, and assert OSC 633 reports base64 `true`, the working directory, and exit code `0`. Always kill the PTY and remove temporary directories in cleanup; skip only when `/bin/zsh` is unavailable or the platform is Windows.

```ts
expect(outputBeforeDelay).not.toContain(TERMINAL_READY_MARKER);
expect(output).not.toContain("function __ca_hist_preexec");
expect(output).not.toContain("function __ca_hist_precmd");
expect(output).toContain(`]633;C;${Buffer.from("true").toString("base64")};`);
expect(output).toMatch(/;0\x07/);
```

### Task 4: Terminal Loading and Timeout Experience

**Files:**
- Modify: `packages/server/app/web/TerminalPane.tsx:54-75,444-532,736-775`
- Modify: `packages/server/app/web/page.tsx:533-538`
- Create: `packages/server/app/web/terminalStartup.test.ts`

**Interfaces:**
- Consumes: `term:start` result field `ready: boolean` and `term:ready` events from Task 2.
- Produces: Monotonic `sessionReady`, eight-second fallback state, `正在启动终端` status overlay, and `终端初始化较慢` warning.

- [x] **Step 1: Subscribe to readiness and preserve response/event races**

Extend the start response type with `ready: boolean`. Reset readiness when the gateway disconnects, set it to true only when either the response says ready or a matching event arrives, and never overwrite an early event with a later false response.

```tsx
useEffect(() => onEvent("term:ready", (message: any) => {
  if (message.id === sessionId.current) setSessionReady(true);
}), [onEvent]);

if (res.ready) setSessionReady(true);
```

- [x] **Step 2: Add the eight-second non-blocking fallback**

Track `startupTimedOut`, reset it on disconnect/new handshake, and arm a timer only while connected and not ready.

```tsx
useEffect(() => {
  if (!state.connected || sessionReady) return;
  setStartupTimedOut(false);
  const timer = window.setTimeout(() => setStartupTimedOut(true), 8_000);
  return () => window.clearTimeout(timer);
}, [state.connected, terminalId, sessionReady]);
```

- [x] **Step 3: Render the overlay without changing xterm geometry**

Wrap the existing terminal host in a stable `position: relative; flex: 1; min-height: 90px` surface. Keep xterm mounted and fitted underneath. While not ready and before timeout, render a theme-colored `role="status" aria-live="polite"` overlay containing a CSS spinner and `正在启动终端`; after timeout, remove the blocker and render `终端初始化较慢` as a small warning.

```tsx
{!sessionReady && !startupTimedOut && !sessionError && visible && (
  <div className="terminal-boot" role="status" aria-live="polite">
    <span className="terminal-boot-spinner" aria-hidden="true" />
    <span>正在启动终端</span>
  </div>
)}
{!sessionReady && startupTimedOut && !sessionError && visible && (
  <div className="terminal-boot-warning" role="status">终端初始化较慢</div>
)}
```

- [x] **Step 4: Add UI contract coverage**

Assert the Ready response/event paths, the `8_000` timeout, both Chinese status strings, mounted terminal host, polite live region, and reduced-motion spinner rule. Keep the current terminal sizing and keybar tests passing.

```ts
expect(paneSource).toContain('onEvent("term:ready"');
expect(paneSource).toContain("8_000");
expect(paneSource).toContain("正在启动终端");
expect(pageSource).toContain(".terminal-boot-spinner");
expect(pageSource).toContain("prefers-reduced-motion:reduce");
```

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/server/lib/shell-integration.test.ts packages/server/lib/shell-integration-pty.test.ts packages/server/lib/command-history-capture.test.ts packages/server/lib/terminal-readiness-contract.test.ts packages/server/app/web/terminalStartup.test.ts packages/server/app/web/terminalSurfaceStyle.test.ts`

Expected: PASS

Run: `bunx tsc --noEmit`

Expected: PASS

Run: `bun run --cwd packages/server build`

Expected: PASS

Run: `git diff --check`

Expected: no output and exit code 0.

If a test fails, fix the implementation or test and rerun the relevant command until it passes. Report the command and result in the final response.
