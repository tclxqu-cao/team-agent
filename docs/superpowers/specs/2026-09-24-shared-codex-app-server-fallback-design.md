# Shared Codex App Server With Standalone Fallback Design

## Problem

AgentRoam currently starts every Codex connection with `codex app-server --stdio`. Each process owns an independent app-server instance, so the desktop and mobile sides can encounter an active-writer lock when they try to continue the same Codex task.

Newer Codex CLI versions provide a local shared daemon and a stdio proxy:

```text
codex app-server daemon start
codex app-server proxy
```

AgentRoam should prefer this shared path so its execution and discovery clients connect through the same machine-level app-server daemon as other compatible Codex clients. Existing installations must keep working when their Codex CLI does not support the daemon or proxy commands.

## Goals

- Keep the existing standalone `codex app-server --stdio` transport available.
- Prefer the shared daemon plus proxy transport without requiring user configuration.
- Start the shared daemon automatically when AgentRoam first needs a Codex connection.
- Fall back to standalone mode when the installed CLI or the shared startup path is unusable.
- Apply the same policy to execution, discovery, and broker-host Codex clients.
- Preserve the existing JSON-RPC client contract and runtime event semantics.

## Non-Goals

- Do not implement explicit mobile/desktop ownership handoff or call `thread/unsubscribe` in this change.
- Do not stop the machine-level daemon when AgentRoam closes a client.
- Do not switch transports in the middle of an active JSON-RPC connection or Codex turn.
- Do not add a Codex version allowlist, settings toggle, or user-visible transport selector.
- Do not change thread, turn, approval, or session ownership behavior above the transport layer.

## Design

### Launch Strategies

Introduce a small launch-strategy boundary alongside `CodexAppServerClient`:

- `SharedCodexAppServerLauncher` runs `codex app-server daemon start`, waits for that command to succeed, and then spawns `codex app-server proxy` as the byte-stream child process.
- `StandaloneCodexAppServerLauncher` preserves the current `codex app-server --stdio` child process.
- `FallbackCodexAppServerLauncher` supplies the ordered startup attempts: shared first, standalone second.

The launcher boundary owns process creation and command-specific lifecycle details. A focused proxy WebSocket adapter performs the standard HTTP Upgrade handshake over the proxy's stdin/stdout and maps each JSON-RPC message to one WebSocket text frame. `CodexAppServerClient` continues to own requests, notifications, server requests, and JSON-RPC initialization; standalone mode retains its existing JSONL framing.

The existing injectable executable, environment, and process-spawn dependency remain available. Tests can therefore exercise both launch strategies without invoking a real Codex process.

### Startup And Readiness

For every fresh connection, including `restart()`, the client follows this sequence:

1. Ask the fallback launcher for the shared attempt.
2. Run `codex app-server daemon start` with the normalized Codex environment.
3. Treat a zero exit as daemon readiness. The command is intentionally idempotent when the daemon is already running.
4. Spawn `codex app-server proxy` with piped stdin, stdout, and stderr.
5. Establish a WebSocket connection through the proxy byte stream. The shared daemon's Unix control socket requires the standard HTTP Upgrade handshake and one JSON-RPC message per text frame.
6. Attach JSON-RPC message handling and send `initialize` followed by `initialized`.
7. Mark shared mode established only after `initialize` succeeds.

The daemon-start command and proxy WebSocket handshake have bounded startup waits. Spawn errors, a non-zero daemon exit, startup timeout, WebSocket upgrade failure, proxy exit/error before readiness, and JSON-RPC initialization failure all reject the shared attempt.

On a rejected shared attempt, the client fully detaches and terminates the attempted proxy, rejects or clears startup-only pending requests, resets its parser state, and starts the standalone attempt. The standalone process is also considered established only after its `initialize` request succeeds.

The CLI version is not parsed or compared. Real command execution plus successful JSON-RPC initialization is the compatibility probe, which avoids coupling AgentRoam to prerelease or future version numbering.

### Failure Semantics

Shared-attempt errors are logged with the failed mode and reason. If standalone initialization succeeds, the original caller continues normally and no `onExit` event is emitted for the failed shared candidate. This prevents an expected compatibility fallback from closing active queues as though an established runtime had crashed.

If both shared and standalone attempts fail, the caller receives the final `RUNTIME_UNAVAILABLE` or protocol error through the existing client contract. The logs retain both failure reasons so the shared-path failure is not lost.

After a transport has been established, an unexpected child exit keeps the current behavior: pending requests fail and registered exit listeners are notified. The client does not silently move an in-flight turn onto another transport. A later explicit `restart()` or the next request's lazy startup performs a fresh shared-first probe, so a transient daemon or proxy failure can recover without permanently pinning the process to standalone mode.

### Lifecycle

`dispose()` terminates only the proxy or standalone child owned by that client. It does not stop the shared daemon because the daemon is machine-scoped and may be serving Codex Desktop, another AgentRoam process, or another local client.

Execution and discovery clients may each own a proxy process, but both proxies connect to the same daemon. Existing construction sites continue creating separate `CodexAppServerClient` instances; their default launcher policy changes from standalone-only to shared-preferred with fallback.

No transport change occurs while a client is healthy. Calls arriving concurrently during startup continue sharing the existing `startPromise`, so only one startup/fallback sequence runs per client.

## Integration Points

- `CodexAppServerClient` uses the fallback launcher by default and performs initialization-aware attempt selection.
- `CodexRuntimeAdapter` requires no call-site policy branching: both its execution client and default discovery client inherit shared-preferred behavior.
- `createNativeRuntimeBrokerHostRuntime` also inherits the same default when it constructs the broker host's Codex client.
- Existing callers that inject a complete client remain unaffected.

## Observability

Startup logs identify:

- the attempted mode (`shared` or `standalone`);
- daemon-start failure, proxy startup failure, or initialization failure;
- the fallback transition;
- the mode that completed initialization.

Logs must not include environment values or other credentials. Existing app-server stderr forwarding remains available with mode-specific context.

## Verification

Add focused unit coverage for:

- shared startup success and the exact command order: daemon start, then proxy, then JSON-RPC initialization;
- the proxy transport sending JSON-RPC as WebSocket text frames rather than raw JSONL;
- idempotent daemon-start success followed by proxy use;
- unsupported daemon command falling back to `app-server --stdio`;
- daemon spawn, non-zero exit, and timeout failures falling back to standalone mode;
- proxy spawn/early-exit and proxy `initialize` failures cleaning up before fallback;
- fallback success remaining invisible to `onExit` listeners;
- both attempts failing with a useful runtime error and both reasons logged;
- `restart()` probing shared mode again after an established process exits or is stopped;
- `dispose()` terminating the owned proxy without issuing a daemon-stop command;
- preservation of current standalone JSON fragmentation, request correlation, environment normalization, notification, server-request, and exit behavior.

Run the focused native-runtime tests, then the package typecheck or build command that covers the modified sources.

## Acceptance Criteria

- A compatible Codex CLI automatically starts or reuses the daemon and serves AgentRoam through `codex app-server proxy`.
- An older or broken shared-mode CLI automatically continues through `codex app-server --stdio` without configuration.
- Shared initialization failures do not leak a false established-runtime exit to consumers when fallback succeeds.
- Restarts always retry shared mode before standalone mode.
- Disposing AgentRoam clients leaves the shared daemon running.
- Existing unrelated working-tree changes are not modified or included in this feature's commits.
