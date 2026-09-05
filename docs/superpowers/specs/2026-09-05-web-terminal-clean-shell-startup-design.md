# Web Terminal Clean Shell Startup Design

## Goal

Opening an AgentRoam Web terminal tab must show a stable loading state and then reveal a clean, interactive prompt. AgentRoam's shell integration source must never appear as typed terminal input, including when the user's zsh startup files or theme take longer than the current 350 ms delay.

The existing command-history behavior remains intact: zsh `preexec` stores the command line, `precmd` captures the real exit status and reports the command, working directory, and exit code through OSC 633, and the History panel continues to retain only successful commands and deduplicate them by command. A new terminal created from a pinned command still runs that command exactly once after integration is ready.

## Current Problem

`startTerminal` spawns the user's login shell and waits a fixed 350 ms before writing the complete zsh integration definition into the PTY as if the user typed it. The command installs `__ca_hist_preexec` and `__ca_hist_precmd` and ends with `clear`.

The delay is unrelated to actual shell readiness. When `.zshrc`, a prompt theme, or a plugin takes longer than 350 ms, the injected source is echoed among startup output before `clear` eventually runs. The same timing mechanism can send an initial pinned command before integration is ready or after a foreground TUI has already taken control.

`TerminalPane` currently considers the terminal ready when the `term:start` RPC resolves. That response only proves that the PTY exists; it does not prove that the interactive shell and AgentRoam integration have finished initializing.

## Approaches Considered

### Loading Overlay Only

Keep the 350 ms injection and cover xterm for a fixed duration. This is the smallest UI change, but the race and possible foreground-program input pollution remain. Faster or slower machines can still reveal the wrong state.

### Prompt Detection Followed By Injection

Scan PTY output for a prompt and inject the hook afterward. Prompts have no portable textual form and may contain colors, asynchronous segments, OSC sequences, or multiline themes. Matching prompt output would remain heuristic.

### Managed Startup Integration And Explicit Readiness

Load AgentRoam integration through shell startup configuration, emit a machine-readable ready marker after user initialization completes, and keep the terminal covered until that marker arrives. This removes the injected command from the input stream and makes UI readiness event-driven. This is the selected approach.

## Shell Integration

Move platform-specific startup construction out of `startTerminal` into a focused shell-integration helper.

For zsh, create a permission-restricted managed `ZDOTDIR` under the server data directory. Its startup files source the corresponding files from the user's original `${ZDOTDIR:-$HOME}` without modifying those files:

- `.zshenv` sources the original `.zshenv`, then restores the managed `ZDOTDIR` for the remaining startup sequence.
- `.zprofile` sources the original `.zprofile`, then restores the managed `ZDOTDIR`.
- `.zshrc` sources the original `.zshrc`, restores the managed `ZDOTDIR`, then defines and registers `__ca_hist_preexec` and `__ca_hist_precmd`. `preexec` stores the command line. As its first operation, `precmd` captures `$?`, then emits the command, working directory, and exit code through OSC 633 and clears the stored command.
- `.zlogin` sources the original `.zlogin`, clears the terminal, restores the original `ZDOTDIR` for nested shells, and emits the AgentRoam ready marker.

All generated paths must be shell-quoted by a dedicated helper. The managed directory uses mode `0700` and its startup files use mode `0600`. A source file must never source itself when the original `ZDOTDIR` already points at the managed directory.

Both history hooks must be prepended to their zsh hook arrays: `precmd_functions=(__ca_hist_precmd $precmd_functions)` and `preexec_functions=(__ca_hist_preexec $preexec_functions)`. In particular, the `precmd` ordering prevents hooks registered by the user's startup files from running commands that overwrite the exit status before AgentRoam reads it.

The spawned zsh process receives the managed `ZDOTDIR` in its environment and continues to use `-l`. No integration source is written through `pty.write` during startup.

For PowerShell, pass the prompt integration as a startup script through `-NoExit -Command` instead of typing it into the PTY after launch. The script installs the existing OSC 7 prompt function, clears the host, emits the same logical ready marker, and remains interactive.

Unsupported shells retain their current interactive startup behavior but are treated as ready immediately because AgentRoam does not install history integration for them. Expanding history integration to additional shells is outside this change.

## Readiness Protocol

The managed shell integration emits an invisible, versioned OSC marker after startup completes. The server recognizes the marker across arbitrary PTY chunk boundaries and sets `session.ready=true`.

The terminal session owns readiness state and a set of readiness watchers, parallel to existing cwd watchers. `term:start` returns the current `ready` value so reconnecting clients do not depend on old scrollback still containing the marker. If a newly attached session is not ready yet, the connection receives one `term:ready` event when initialization completes.

When readiness is reached, the server writes a validated `initialCommand` to the PTY exactly once. The write happens after history integration is installed, so the command is stored by `preexec` and reported by `precmd` with its actual exit status after it finishes. Reattaching to an existing session never replays the command.

The OSC marker remains terminal control data and renders no visible characters. The client does not infer readiness by inspecting prompt text.

## Loading Experience

`TerminalPane` starts each new PTY in a `booting` state. A fixed overlay covers the xterm surface and shows a compact spinner with `正在启动终端`. The overlay uses existing terminal theme colors, does not resize the terminal, and is exposed as a polite status for assistive technology.

Receiving `ready=true` from `term:start` or a matching `term:ready` event transitions the pane to ready and fades the overlay out. The xterm instance remains mounted and fitted underneath the overlay throughout startup, so revealing it does not cause a geometry jump.

If readiness has not arrived within eight seconds, the overlay stops blocking the terminal and shows the existing PTY output. A small non-blocking warning states `终端初始化较慢`; the session may still become ready later. A shell exit continues to use the existing terminal startup failure state.

## Data And Lifecycle

Readiness is process-local terminal state, not durable user data. It is not added to `terminal_tabs`. A live session keeps its ready state across browser reconnects; a new process creates a new PTY and performs startup again.

Closing a terminal removes its readiness watchers together with the existing data and cwd watchers. Managed startup files are shared server infrastructure and are replaced atomically when their version changes rather than created separately for every tab.

## Validation

Server unit tests will verify:

- generated zsh startup files source the original files in order and quote paths safely;
- both history hooks, their prepend ordering, the exit-code field, and the ready marker are present in managed startup content;
- `command-history-capture.test.ts` verifies the generated helper content or exported protocol behavior instead of requiring the hook source to remain inline in `ws-server.mjs`;
- the OSC 633 parser continues to accept the optional exit-code field for compatibility with existing sessions and passes it to history storage;
- the old delayed zsh and PowerShell `pty.write` bootstrap is absent;
- a ready marker split across output chunks transitions the session once;
- `initialCommand` is written once, only after readiness, and is not replayed on reattach;
- unsupported shells become ready without waiting for an integration marker.

A real PTY integration test will use an isolated `ZDOTDIR` whose `.zshrc` sleeps longer than 350 ms. It must prove that the visible output never contains `__ca_hist_preexec`, `__ca_hist_precmd`, or hook registration source, readiness arrives after the delayed startup completes, the final surface is cleared, and a submitted command is reported through OSC 633 with its actual exit status. Existing store tests continue to verify that failed commands are omitted and successful commands are deduplicated.

Terminal UI coverage will verify that the loading overlay is present before readiness, disappears for both response-time and event-time readiness, preserves stable xterm dimensions, and falls back to visible output after eight seconds.

The focused tests, Server TypeScript check, production Server build, and `git diff --check` form the implementation gate. Browser acceptance will open a fresh terminal with a deliberately slow zsh startup and confirm the loading-to-clean-prompt transition on desktop and a 390x844 mobile viewport.

## Out Of Scope

This change does not alter the default cwd. A normal `+` terminal continues to start in `$HOME` unless a caller explicitly supplies `cwd`. It also does not change history retention, add shell integration for bash or fish, alter terminal tab restoration, or publish/restart the `:3000` production service.
