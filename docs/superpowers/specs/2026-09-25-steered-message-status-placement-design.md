# Steered Message Status Placement

## Goal

Make a successfully steered queued message feel consistent with the existing send-state feedback and reduce visual weight in the message timeline.

## Design

For a user message with `isSteered=true`, render a small green turn-arrow status icon in the message bubble's bottom-right status row. It occupies the same visual location as the pending send dots, but the two states remain independent: pending dots are shown only while `sendState="pending"`, and the steered icon is shown after steering succeeds.

Remove the separate green `已引导` pill below the bubble. Keep the copy control outside the bubble as an action; the steered indicator is read-only status and must not look clickable. The icon exposes `title="已引导"`, `aria-label="已引导"`, and `role="img"` so its meaning remains available without visible text.

Queued messages keep the existing `排队中` badge and `引导` action until steering succeeds. The change applies to the shared Codex-style history used by Desktop and WebApp and does not alter queue state, `isSteered` persistence, steering IPC, or runtime capability checks.

## Verification

- Source regression confirms the steered status is inside the message bubble status row.
- Source regression confirms the old visible `已引导` pill is removed.
- Existing pending/failed send-state and queued-message interaction tests continue to pass.
- Desktop TypeScript and `git diff --check` pass.

