# Mobile Web Chat UX Design

## Subject And Job

Customer Agent's Web shell is a phone-operated control surface for people who repeatedly switch sessions, inspect agent output, and send short commands. Its single job is to make the correct conversation and the send action reachable with one thumb without reducing the desktop renderer's capability.

## Evidence

- The current 390 x 844 layout renders the full chat, but 26px avatars and keyboard hints consume scarce width and height.
- The session drawer works, but project/session rows and destructive actions are smaller than reliable touch targets.
- The composer already exposes the right controls, yet context usage, attachment, input, and send compete visually.
- The ZCode mobile reference succeeds through a shallow hierarchy, 42-44px controls, dense task rows, quiet chrome, and explicit current-state treatment. Its dark branding is not part of this design.

## Options Considered

### A. Web-Shell Styling With Semantic Hooks (Selected)

Add stable class names to the shared renderer and keep all phone-specific layout rules in `packages/webapp/src/presentation/web.css`. This preserves one behavior implementation, keeps Electron unchanged, and has the smallest regression surface.

### B. Dedicated Mobile React Components

Create separate mobile header, drawer, message, and composer components. This gives maximum structural control but duplicates shared behavior and increases the chance that desktop and Web features drift.

### C. Separate Mobile Application Shell

Build a phone-only application around the HTTP gateway. This could be highly tailored, but it is unnecessary for the current interaction problems and would duplicate routing, stores, settings, and session lifecycle code.

## Visual System

The Web shell inherits the active renderer skin. The Pearl defaults are canvas `#f5f6fa`, surface `#ffffff`, ink `#111827`, secondary `#4b5563`, accent `#4f6ef7`, success `#059669`, and hairline `rgba(17, 24, 39, 0.07)`. No new decorative gradient or mobile-only theme is introduced.

Body text uses the native phone stack (`-apple-system`, `BlinkMacSystemFont`, `PingFang SC`, `Noto Sans SC`, sans-serif) for fast Chinese rendering. Token and path data retain `IBM Plex Mono`. Headings stay compact and use the body family at 600 weight; there is no display-scale typography inside the app shell.

## Layout

```text
+--------------------------------+
| [sessions]  current title  [..] |  52px header
+--------------------------------+
|                                |
| assistant response             |
|                         command|
| assistant response             |  scrollable conversation
|                                |
+--------------------------------+
| context ----------------  5%   |  context ribbon
| [+] message input        [send] |  thumb dock
+--------------------------------+
```

The session drawer occupies `min(88vw, 348px)`, respects safe areas, and uses full-width 44px rows. The active session keeps the existing accent rail as the list's signature state. The drawer toggle changes from menu to close while open.

The conversation removes avatars below 900px and uses role-specific message modifiers. User bubbles remain compact and right-aligned at no more than 88% width. Assistant responses use the available width and a quiet surface boundary for readable code, tools, and long answers. Per-message speech and copy actions are icon-only, unframed controls rendered below and outside the message-card boundary; their names remain available through tooltips and accessible labels.

The header, conversation, and composer gutter form one continuous canvas. They share the same background, with no full-width white input band or hard divider between sections. Role geometry carries the message hierarchy: user messages remain compact bubbles while assistant output stays unframed and full width.

The composer is the signature element: a fixed visual dock with one quiet outline and one shared surface. Context usage is an inset 4px status rail rather than a separate header: it has no divider, uses the same 12px horizontal rhythm as the input row, and keeps its label and numeric summary visually secondary. The shell owns the radius and focus treatment, so the context rail, input, attachment button, and send button read as one control. Attachment and send controls are 44px circles, the input row remains at least 56px tall, the text field remains 16px to prevent iOS zoom, and desktop-only keyboard help is hidden. The dock has no elevation shadow and remains above `safe-area-inset-bottom` and the browser keyboard.

## Interaction And Accessibility

- All primary mobile controls are at least 42px in both dimensions.
- The session toggle exposes `aria-expanded` and an icon that reflects the open state.
- Focus-visible behavior remains available; touch-specific rules do not remove keyboard semantics.
- Motion is limited to the existing drawer transition and respects `prefers-reduced-motion`.
- Opening a session closes the drawer. Tapping the scrim closes it without changing the current session.

## Scope Boundaries

- Do not change API contracts, session lifecycle, persistence, model configuration, or message sending behavior.
- Do not alter the Electron layout or desktop breakpoints.
- Do not copy ZCode colors, wording, or workspace card layout.
- Do not add dependencies, custom fonts, bottom navigation, gestures, or destructive-action redesign.

## Verification

- Build and typecheck the WebApp and run the existing chat/session tests.
- At 390 x 844, verify header, drawer, message widths, composer controls, safe-area spacing, and absence of overlap.
- Open/close the drawer, select a session, send a harmless message, confirm stream-before-run request order, receive a reply, and reload to confirm persistence.
- At desktop width, verify the sidebar and chat remain unchanged.
