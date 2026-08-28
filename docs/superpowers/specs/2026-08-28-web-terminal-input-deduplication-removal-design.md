# Web Terminal Input Deduplication Removal Design

## Goal

Restore normal Web terminal input semantics while retaining xterm's built-in mobile composition handling. Holding Backspace must delete continuously, fast repeated characters such as `aa` and `ll` must remain intact, and iPhone dictation must not be modified by a content-based timer in application code.

## Current Problem

`TerminalPane` currently stores the most recently emitted xterm `onData` payload and drops an identical payload received within 500 ms. This filter cannot distinguish dictation from ordinary terminal input:

- every Backspace produces `\x7f`, so key repeat is throttled;
- fast repeated printable characters are removed;
- repeated control sequences can be removed;
- input appears delayed because accepted deletions are separated by the 500 ms window.

The gateway and PTY paths forward accepted input immediately. The delay is introduced before transport, inside the `TerminalPane` `onData` callback.

## Design

Remove the timestamp-based, content-based duplicate filter and its `lastOutboundInput` state. Each xterm `onData` event will be forwarded immediately through the existing `sendInput` path, subject only to existing semantic handling:

- ignore navigation escape sequences known to leak from an active mobile touch-scroll gesture;
- apply the existing one-shot virtual Ctrl transformation;
- update the terminal's follow-output and scroll state;
- send the resulting data once through the WebSocket channel, with the existing RPC fallback.

Do not add a replacement timer, phrase comparison, composition listener, or application-level IME state machine. xterm 6 already owns textarea, composition, `beforeinput`, and `input` event coordination; the Web terminal should treat its `onData` output as the authoritative terminal byte stream.

To make the remaining suppression rule explicit and testable, isolate only the touch-scroll escape check as a stateless predicate. It must not inspect timestamps or previous input and must never suppress printable text, Backspace, paste data, or repeated calls with the same value outside the defined touch-scroll escape cases.

## Input Flow

1. The browser keyboard, IME, dictation, paste operation, or xterm key handling produces an xterm `onData` event.
2. If a mobile touch-scroll gesture is active and the payload is one of the existing blocked navigation sequences, ignore it.
3. Update follow-output state and apply the existing virtual Ctrl mapping when armed.
4. Forward the payload immediately through `sendTerminalInput`; use `term:input` RPC only when the direct channel is unavailable.
5. The gateway writes the payload to the PTY without additional input deduplication.

## Error Handling

This change does not alter connection, write-lock, WebSocket fallback, or RPC error behavior. Disconnected input remains ignored as it is today. Removing the timer introduces no new recoverable error state.

If iPhone dictation still duplicates after this change, capture the actual composition/input/onData event sequence on the affected device. A source-aware normalization design may then be introduced from that evidence. Do not restore a global content-and-time filter as a fallback.

## Testing

Add focused regression coverage for the remaining stateless suppression rule:

- repeated `a`, `l`, `\x7f`, and multi-character payloads are not suppressed;
- repeated identical calls remain independent;
- navigation escapes are suppressed only while touch scrolling is active;
- the same navigation escapes pass when touch scrolling is inactive.

Run the relevant Vitest test, the server type check, and a production build or the narrowest existing equivalent that validates `TerminalPane` compilation.

Perform interactive Web terminal checks:

- type `aa` and `ll` rapidly and confirm both characters arrive;
- hold Backspace and confirm continuous deletion without 500 ms pauses;
- paste repeated text and confirm it is unchanged;
- use iPhone dictation with a repeated phrase and with a longer cumulative phrase, confirming the final shell input contains one intended copy;
- confirm virtual Ctrl keys and touch scrolling retain their existing behavior.

The iPhone dictation check is the acceptance gate for relying on xterm alone. If it fails, record the device/browser version and event trace and stop before shipping this approach.

## Non-Goals

- Building a new voice-input or IME normalization state machine.
- Correcting or merging dictation text in application code.
- Changing gateway framing, PTY writes, terminal session ownership, or reconnection behavior.
- Refactoring unrelated mobile scrolling, keybar, theme, or multi-terminal changes already present in `TerminalPane`.

## Rollback

Revert only this focused input-policy change if it causes a confirmed regression. Any replacement must distinguish input sources and be based on a captured failing event sequence; the previous global 500 ms duplicate filter is not an acceptable rollback implementation because it is known to corrupt valid terminal input.
