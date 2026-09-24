# WebApp Session Isolation Design

## Problem

When switching between Customer Agent and native runtime sessions, delayed events or an unresolved session summary can briefly be interpreted as belonging to the newly selected session. A subsequent history refresh corrects the visible list, which makes the contamination appear transient.

## Design

- A streamed event may mutate message state only when it carries an explicit `_sid`.
- Event routing uses `_sid` as the sole owner key; the currently viewed session is used only to decide whether visible-only UI state should update.
- An existing selected session is not composable until its matching session summary is available. New-session composition continues to use the active agent type.
- History responses retain the existing generation and selected-session guards.

## Verification

- Unit test explicit event ownership and rejection of unscoped events.
- Source-contract test the selected-session composer guard.
- Run the affected renderer tests and the WebApp build.
