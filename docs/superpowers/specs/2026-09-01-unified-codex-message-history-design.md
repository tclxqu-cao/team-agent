# Unified Codex-Style Message History Design

## Goal

Make the Electron desktop message history match the established Codex-style Web history for every runtime: Customer Agent, Codex, and Claude Code. Only the message history changes; the desktop header, sidebar, composer, runtime behavior, and persisted message data remain unchanged.

## Visual Contract

- Use one centered reading lane with a maximum width of `860px`.
- Hide both user and assistant avatars.
- Render assistant text as transparent document content without a card border, background, radius, shadow, or horizontal card padding.
- Keep user messages as right-aligned bubbles with a maximum width of `min(78%, 680px)`.
- Render tool calls as transparent, compact `32px` summary rows aligned to the assistant reading lane.
- Preserve expandable tool arguments, command output, results, and error details.
- Keep the existing human-readable tool summaries for Customer Agent, Codex, and Claude Code tools.
- Align the running activity indicator with the reading lane after avatars are removed.
- Make long-message fade treatment blend into the message-area background rather than the removed assistant card.

## Implementation Boundary

Add a stable Codex-history modifier to the shared `ChatView` root and place the shared visual rules in the desktop renderer stylesheet. Remove or narrow duplicate Web-only message-history overrides so Web and Electron use one visual contract. Keep Web-only composer, mobile, settings, and shell rules under `body[data-web-shell="1"]`.

No runtime-specific message rendering branch will be introduced. The existing shared `ChatView` and `ToolCallCard` structures remain the source of truth, so all three runtime types receive the same presentation automatically.

## Verification

- Add focused style-contract coverage proving the shared history modifier owns the document-lane, avatar, assistant, user-bubble, and tool-row rules.
- Run the affected Vitest suite and the desktop renderer build/type checks available in the repository.
- Restart the Electron desktop application.
- Visually verify a conversation containing assistant text, a user message, a collapsed tool call, and an expanded tool call. Confirm the three runtime types share the same DOM/style path and that the message area has no horizontal overflow.

## Non-Goals

- Redesigning the desktop composer, top bar, sidebar, settings, or appearance controls.
- Changing tool-call data, runtime adapters, persistence, or streaming behavior.
- Adding a classic/Codex style toggle.
