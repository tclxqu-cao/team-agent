# Message Image Lightbox Design

## Problem

Message images currently call `window.open(dataUrl, "_blank")`. Mobile Safari
can block or mishandle Data URL tabs, and the behavior is inconsistent between
optimistic `ChatMessage.images` and persisted `presentation.attachments`.

## Decision

Add one portal-based `MessageImageLightbox` shared by every usable image in the
message renderer. Clicking either an optimistic sent image or a persisted image
attachment opens the original source against a viewport-sized dark backdrop.

The lightbox renders under `document.body` so Web shell overflow and stacking
contexts cannot clip it. It uses `object-fit: contain`, viewport and safe-area
constraints, a close icon button, backdrop click, and Escape handling. Body
scroll is locked while open and restored exactly when it closes. Unavailable
attachment placeholders remain inert.

## Alternatives

- Keep `window.open`: minimal code, but unreliable for Data URLs on mobile and
  provides no consistent in-app close behavior.
- Use native `<dialog>`: gives built-in modal semantics, but adds cross-browser
  top-layer behavior that does not match the existing portal overlay pattern.

## Verification

Add component tests for portal, modal semantics, Escape, backdrop close, body
scroll restoration, and full-resolution source rendering. Keep a ChatView
contract test proving both message-image branches open the shared lightbox.
Run renderer/WebApp tests and type checks, rebuild WebApp, restart port 3000,
and verify the deployed bundle contains the new lightbox.
