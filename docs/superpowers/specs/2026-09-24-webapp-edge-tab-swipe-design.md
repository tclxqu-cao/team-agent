# WebApp Edge Tab Swipe Design

## Goal

Keep horizontal tab switching while allowing native text selection and copying throughout the message history.

## Behavior

- A tab swipe may start only within 24 CSS pixels of the left or right viewport edge.
- Once accepted at an edge, the gesture continues normally as the pointer moves inward.
- Gestures starting outside the edge zone never emit tab-swipe messages and never call `preventDefault()`.
- Existing interactive-target and vertical-motion exclusions remain unchanged.

## Verification

Unit tests cover both edges, the exact boundary, center-origin gestures, interactive controls, vertical motion, and cancellation.
