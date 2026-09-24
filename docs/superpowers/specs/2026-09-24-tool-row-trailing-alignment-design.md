# Tool Row Trailing Alignment Design

## Goal

Align file-action disclosure chevrons with ordinary tool-row chevrons while moving the line-count badge toward the same trailing edge.

## Design

In Codex history rows, the separate disclosure control occupies the chevron's 11px visual column instead of a 34px layout column. A positioned pseudo-element keeps the disclosure's effective touch target 34px wide without consuming layout space. The preview button therefore gains 23px, moving its trailing metadata right while preserving filename ellipsis.

## Verification

Add CSS contract assertions, run the focused component/style tests, build WebApp, and inspect the mobile row in the served application.
