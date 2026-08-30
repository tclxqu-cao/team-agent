# WebApp Tab Swipe Bridge Design

## Background

`/web` keeps every terminal tab mounted in a horizontally translated track. Regular terminal tabs render `TerminalPane` in the parent document, so the track receives their pointer events. The first built-in "智能助手" tab renders `/app/` in a full-size iframe; pointer events do not cross the iframe document boundary, so the parent never sees a swipe that starts inside that tab.

## Goal

Make horizontal swipes in the built-in WebApp tab switch `/web` tabs with the same threshold and track animation as regular terminal tabs, while preserving vertical chat scrolling and interactive controls.

## Design

The WebApp installs a small touch gesture bridge at its composition root. It tracks primary touch pointers, waits until movement exceeds 8px, and classifies the gesture as horizontal only when horizontal distance is at least 1.2 times vertical distance. Vertical gestures remain entirely inside the WebApp.

For a horizontal gesture, the child sends same-origin `postMessage` events containing a versioned message type, phase (`move`, `end`, or `cancel`), and horizontal delta. The `/web` parent accepts messages only when both `event.origin` matches the current origin and `event.source` is the built-in iframe window. Move events update the existing track delta; end events reuse the existing 64px commit threshold; cancel events reset the track.

Gestures beginning on inputs, textareas, content-editable elements, links, buttons, or explicit opt-out regions are ignored. The mobile WebApp main surface uses `touch-action: pan-y`, allowing vertical browser scrolling while keeping horizontal pointer events available to the bridge.

## Error Handling

Malformed, cross-origin, non-finite, unknown-phase, or wrong-source messages are ignored. If a touch is cancelled after horizontal tracking starts, the child emits `cancel` so the parent track returns to the active tab.

## Verification

- Unit-test axis arbitration, interactive-target exclusion, horizontal move/end emission, vertical cancellation, and pointer cancellation.
- Unit-test parent message parsing and origin/source rejection.
- Run WebApp typecheck/build and focused Vitest suites.
- In a 390x844 browser viewport, verify the first tab swipes to the next terminal and vertical chat scrolling remains unchanged.
