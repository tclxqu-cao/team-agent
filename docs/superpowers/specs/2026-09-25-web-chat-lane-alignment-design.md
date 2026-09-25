# Web Chat Lane Alignment

## Problem

The shared Codex history styles cap message groups at 860px, while the Web shell
uses a 92% lane for the message viewport and composer. On wide Web viewports this
leaves a large empty strip beside the conversation. The fallback activity row is
also outside the centered message group, so `思考中` can appear left of the
conversation.

## Design

- Keep the existing 860px reading lane for Electron.
- In the Web shell, let message groups, execution traces, non-compact runtime
  progress rows, and fallback activity rows use the full width of the existing
  Web chat lane.
- Center the fallback activity row with the same ownership rule as other message
  rows. It must occupy only its intrinsic height and remain directly after the
  latest visible content.
- Keep user bubbles constrained by their existing percentage cap.
- Do not change message data, runtime state, scrolling, composer behavior, or
  mobile layout. The existing mobile lane remains 100%.

## Acceptance

- On a wide Web viewport, assistant text, tool rows, reasoning rows, execution
  traces, and `思考中` share the same left and right content boundaries as the
  composer lane.
- `思考中` no longer drifts to the left and does not create a growing blank row.
- Electron retains its current centered 860px message lane.
- Narrow Web viewports remain free of horizontal overflow.

## Verification

- Add focused stylesheet contract coverage for the Web-only overrides.
- Build the WebApp and inspect wide and narrow screenshots after deployment.
