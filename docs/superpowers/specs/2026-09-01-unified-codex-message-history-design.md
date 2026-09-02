# Unified Codex-Style Message History Design

## Goal

Make the Electron desktop conversation surface match the established Codex-style Web experience for every runtime: Customer Agent, Codex, and Claude Code. The desktop header, sidebar, runtime behavior, and persisted message data remain unchanged.

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

## Composer Contract

- Electron and Web render the same two-level composer structure: a multiline textarea above one complete action toolbar.
- Context usage moves into the toolbar as the existing compact ring control.
- Model selection, runtime status, reasoning effort or native-agent status, stop, and send keep their current Web behavior.
- Attachment, image, voice, and clipboard screenshot actions remain available from the shared add menu.
- Running conversations preserve queue-send and stop behavior.
- The shared composer uses the same control geometry, focus treatment, spacing, and rounded shell in both consumers; Web-only safe-area and narrow-phone rules remain scoped to Web.

## Implementation Boundary

Add a stable Codex-history modifier to the shared `ChatView` root and place shared history and composer rules in the desktop renderer stylesheet. Remove or narrow duplicate Web-only overrides so Web and Electron use one visual contract. Render one shared textarea and action toolbar instead of branching between Electron and Web composer markup. Keep Web-only safe-area, narrow-phone, settings, and shell rules under `body[data-web-shell="1"]`.

No runtime-specific message rendering branch will be introduced. The existing shared `ChatView` and `ToolCallCard` structures remain the source of truth, so all three runtime types receive the same presentation automatically.

## Verification

- Add focused style-contract coverage proving the shared history modifier owns the document-lane, avatar, assistant, user-bubble, tool-row, and composer rules.
- Run the affected Vitest suite and the desktop renderer build/type checks available in the repository.
- Restart the Electron desktop application.
- Visually verify a conversation containing assistant text, a user message, a collapsed tool call, and an expanded tool call. Confirm the three runtime types share the same DOM/style path, the shared composer is visible in Electron and Web, and neither surface has horizontal overflow.

## Non-Goals

- Redesigning the top bar, sidebar, settings, or appearance controls.
- Changing tool-call data, runtime adapters, persistence, or streaming behavior.
- Adding a classic/Codex style toggle.
