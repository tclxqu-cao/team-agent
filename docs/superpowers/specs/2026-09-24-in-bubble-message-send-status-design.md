# In-Bubble Message Send Status Design

## Goal

Make an optimistic user message feel like it is being sent without showing a separate loading spinner beneath the message. Keep the copy action independent and usable.

## Interaction

- A user message with `sendState: "pending"` shows a three-dot pulse indicator in the bottom-right corner of its message bubble.
- The indicator is part of the bubble layout, does not cover message text, and does not create a separate status row.
- The existing copy button remains outside the bubble in the message action area and stays usable while the message is pending or failed.
- The pending indicator disappears on `run_admitted` or the first meaningful run event, including `thinking`.
- A failed send keeps the message text and replaces the animation with a small red `发送失败` label inside the bubble.
- Queue and steer badges keep their existing behavior and remain outside the bubble.
- Agent-side `思考中` remains unchanged because it describes processing rather than message transport.

## Visual Behavior

- The three dots animate through opacity and a small vertical offset in sequence.
- The message body does not shimmer, pulse, or change opacity.
- The indicator reserves stable space so its animation does not resize the bubble.
- Under `prefers-reduced-motion: reduce`, the dots are static and the rest of the status remains visible.

## Implementation Scope

- Move user `sendState` rendering into the existing user message bubble in `ChatView.tsx`.
- Remove the pending `LoaderCircle` from this message-send path while retaining other loaders in the component.
- Replace the existing external send-status styles with in-bubble pending and failed styles in `global.css`.
- Preserve the existing per-message state model and event-driven acknowledgement logic.
- Desktop and WebApp receive the same behavior through the shared renderer.

## Verification

- A pending message renders three animated dots inside its bubble and no external spinner.
- The copy button remains outside the bubble and remains enabled.
- `run_admitted` and first meaningful run events clear the pending state.
- A failed send retains the message content and shows `发送失败` inside the bubble.
- Reduced-motion mode disables dot movement.
- Focused tests, renderer type checking, and relevant production build checks pass.

## Non-Goals

- Redesigning the message action toolbar.
- Changing queue, steer, or Agent thinking UI.
- Adding resend behavior.
- Changing the transport or optimistic-send state model.
