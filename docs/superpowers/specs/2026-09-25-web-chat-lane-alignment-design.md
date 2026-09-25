# Desktop And Web Chat Lane Alignment

## Problem

The shared Codex history styles cap message groups at 860px while the composer
uses a wider responsive lane. On wide Desktop and Web viewports this leaves a
large empty strip beside the conversation and prevents the content from adapting
when the window is resized. The fallback activity row is also outside the
centered message group, so `思考中` can appear left of the conversation.

## Design

- Use one shared responsive chat lane for Desktop and Web: 92% of the available
  chat surface on viewports at least 900px wide, and 100% below 900px.
- Make the message viewport and composer use that lane. Inside it, message groups,
  execution traces, non-compact runtime progress rows, and fallback activity rows
  use the full available width instead of an independent 860px cap.
- Center the fallback activity row with the same lane rule as other message rows.
  It must occupy only its intrinsic height and remain directly after the latest
  visible content.
- Keep user bubbles constrained by their existing percentage cap.
- Do not change message data, runtime state, scrolling, or composer behavior.
- File drawer and sidebar width changes naturally resize the available chat
  surface and therefore the shared lane.

## Acceptance

- On wide Desktop and Web viewports, assistant text, tool rows, reasoning rows,
  execution traces, and `思考中` share the same left and right content boundaries
  as the composer lane.
- Resizing either client changes the lane proportionally without retaining a
  fixed 860px message column.
- `思考中` no longer drifts to the left and does not create a growing blank row.
- Narrow viewports use the full available width without horizontal overflow.

## Verification

- Add focused stylesheet contract coverage for the shared lane and Web shell
  integration.
- Build Desktop and WebApp assets and inspect wide and narrow screenshots after
  deployment.
