# Mobile Composer Density Design

## Background

The mobile Web composer currently promotes its attachment and send controls to 44px circles. In the compact, single-surface composer this makes both controls visually heavier than the text field. The context ribbon also spends substantial horizontal space on the exact `used / maximum` token count even though the percentage and progress bar already communicate the current state.

## Goal

Make the phone composer quieter and better balanced by reducing the two primary circle controls and removing exact token counts from the inline context ribbon.

## Design

The WebApp phone breakpoint uses 38px circles for add, send, and stop controls, with consistent 18px add/send icons. The input row keeps its existing stable minimum height and touch spacing, so shrinking the circles does not cause layout shift.

`ContextUsageBar` gains an optional compact summary mode. Compact mode renders only the percentage (`4%`); the existing progress meter, label, button semantics, and detail popover remain unchanged. `ChatView` enables compact mode only for the browser Web Shell, so Electron keeps the full `4.5K / 100K · 4%` summary.

## Verification

- Unit-test full, compact, and empty compact context summaries.
- Run the focused ContextUsageBar test, WebApp typecheck, WebApp build, and Server build.
- At 390x844, verify both circles compute to 38px, both icons to 18px, and the inline summary contains only a percentage.
