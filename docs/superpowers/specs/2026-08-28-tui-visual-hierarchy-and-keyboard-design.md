# Customer Agent TUI Visual Hierarchy and Keyboard Design

## Goal

Make the TUI feel like a focused operator console: the startup state should look intentional, each information region should be immediately recognizable, semantic colors should stay consistent, and slash/mention palettes must be fully operable with the keyboard in common terminal cursor modes.

## Approaches Considered

### A. Semantic console bands (selected)

Use a compact brand bar, a separate context line, an unframed transcript, a status band, and one framed interaction region containing the palette and composer. Centralize semantic color and glyph tokens. This preserves terminal density while giving every region a stable visual role.

### B. Boxed dashboard

Put header, transcript, tools, status, and input in separate bordered panels. This makes boundaries explicit but spends too many terminal rows and produces nested-box noise at normal laptop terminal heights.

### C. Minimal readline console

Return to the previous one-shot banner and plain streaming lines. It is compact and familiar, but it cannot give palettes, inline questions, and live tool progress enough hierarchy.

## Visual Direction

The audience is a developer repeatedly operating an Agent from a local terminal. The design uses a restrained “signal desk” language: cool cyan identifies the Agent and active selection, mint identifies user input and ready state, amber identifies in-progress work and questions, magenta identifies tools, and red is reserved for failures.

Ink uses terminal colors rather than web typography. Hierarchy comes from bold labels, restrained dividers, stable indentation, and consistent semantic markers.

```text
╭─ CUSTOMER AGENT ─────────────────────────────── ready ─╮
│ model  openai/gpt-x   project  customer-agent   ab12cd │
╰────────────────────────────────────────────────────────╯

YOU    message
AGENT  streamed response
TOOL   bash  { command: ... }
       result  ...

──── thinking · 2.9s ────────────────────────────────────
╭─ COMMANDS · 2/12 ──────────────────────────────────────╮
│ Commands                                                │
│  › /new      新建会话                                   │
│    /open     打开会话                                   │
│                          ↑↓ move  enter select  esc close│
├─ MESSAGE ───────────────────────────────────────────────┤
│ › /                                                        │
╰─────────────────────────────────────────────────────────╯
```

The signature element is the continuous interaction frame: palette and composer read as one keyboard surface without putting cards inside cards.

## Component Boundaries

- `theme.ts` owns colors, role labels, status copy, and terminal-safe glyphs.
- `Header.tsx` owns brand, model, project, session, and ready/running state.
- `Transcript.tsx` owns role rails for user, Agent, tool call, tool result, notice, and error entries.
- `ProgressLine.tsx` owns the live/completed status band and token usage.
- `CommandPalette.tsx` owns grouped candidates, selected position, disabled state, scrolling, and keyboard help.
- `Composer.tsx` owns the framed input surface and normalized keyboard navigation.
- `App.tsx` composes the regions and supplies state; it does not duplicate visual tokens.

## Keyboard Contract

When a palette is open, Up and Down change the selected candidate and never navigate input history. Enter selects the highlighted candidate and Escape closes the palette. Navigation recognizes both Ink key flags and the common raw sequences `ESC [ A/B` (CSI) and `ESC O A/B` (SS3). Selection wraps at list boundaries and remains visible in the scrolled window.

When no palette is open, Up and Down retain input history behavior. Left, Right, Backspace, Ctrl+C, and inline-question behavior remain unchanged.

## Responsive Behavior

The UI must render cleanly at 60 columns and above. Long model ids, paths, candidate descriptions, tool arguments, and transcript text truncate or wrap within the terminal width without changing marker columns. The startup state always includes an action-oriented empty message and the `/` and `@` discovery hints, but does not show a large decorative logo.

## Verification

- Unit-test CSI and SS3 Up/Down input while the slash palette is open.
- Unit-test that palette movement does not mutate input history.
- Preserve command, mention, model, session, stream, and `ask_user` tests.
- Type-check the TUI package.
- Run the built TUI in a real PTY and verify startup hierarchy, slash palette highlight movement, selection, mention palette, and no overlapping content at a narrow terminal width.
