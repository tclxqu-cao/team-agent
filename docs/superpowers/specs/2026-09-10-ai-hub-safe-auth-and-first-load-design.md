# AI Hub Safe Authentication and First-Load Design

## Goal

Fix AI Hub panes that remain blank until a manual refresh, remove browser-identity spoofing, and handle Google authentication without attempting to bypass Google's embedded-browser policy.

## Scope

- DeepSeek, ChatGPT, Gemini, Grok, and custom sites must render on the first selection without requiring refresh.
- The desktop site selector matches the mobile Web AI Hub interaction: it lives inside the composer and supports one to four selected sites.
- One selected site fills the available page area; two to four selected sites automatically render as resizable split panes.
- Existing embedded logins that the provider allows, including direct email login, remain available.
- Google authentication URLs are not loaded inside `WebContentsView`.
- A Google authentication attempt opens the selected provider's home page in the system browser and marks that pane with a clear message directing the user to use email login inside AI Hub when available.
- Existing multi-site broadcast and persistent `persist:aihub-<siteId>` sessions remain unchanged.

## Non-Goals

- Pretending Electron is Google Chrome through User-Agent or client-hint mutation.
- Copying Chrome cookies or credentials into Electron.
- Making a system-browser tab participate in AI Hub broadcast.
- Replacing embedded provider pages with official provider APIs in this change.

## Architecture

### First-Load Bounds Coordination

The renderer can issue `hub:set-bounds` before `hub:open` finishes creating a site's `WebContentsView`. The current manager drops bounds for unknown views, so the new view stays detached until another layout event or refresh.

`AIHubManager` will retain the latest requested pane rectangles by `siteId`. `setBounds` replaces this retained layout, applies rectangles to existing views, and detaches views omitted from the new layout. After `openSite` creates or retrieves a view, it immediately applies the retained rectangle for that site. An empty layout clears the retained rectangles and hides every view.

The retained-layout behavior will be implemented as a small pure state helper so ordering can be unit-tested without launching Electron.

### Authentication Navigation Policy

A pure URL policy will identify HTTPS Google Account authentication hosts such as `accounts.google.com`. It will reject non-HTTPS URLs and avoid matching lookalike domains.

Each AI Hub view will apply the policy to both same-view navigation (`will-navigate`) and popup navigation (`setWindowOpenHandler`). When a Google authentication URL is detected, the embedded navigation is cancelled. Electron `shell.openExternal` opens the configured provider home page, allowing the user to start a supported browser login there. The manager emits a dedicated `google-auth-external` event for the pane.

Opening the provider home page rather than transferring the raw OAuth URL avoids claiming that OAuth state or Electron cookies can move between browser profiles. The system-browser session remains separate and is not imported back into AI Hub.

### Browser Identity

The manager will stop overriding:

- `User-Agent`
- `Sec-CH-UA` and related client-hint headers
- `navigator.userAgentData`

The existing sandbox, context isolation, disabled Node integration, persistent per-site partitions, and media-only permission handler remain intact.

### Renderer Feedback

`HubEvent` gains `google-auth-external`. `AIHubView` uses this event instead of page-title text matching. The pane header displays a concise warning that Google login opened in the system browser and that email login should be used inside AI Hub when the provider supports it.

The warning does not claim that system-browser login will synchronize back to AI Hub. Reloading or navigating normally clears the stale warning.

### Unified Site Selection

The desktop renderer will remove the fixed left site sidebar and the top-bar `单屏` / `对比` segmented control. A single ordered `selectedIds: string[]` state becomes the source of truth for both visible panes and broadcast recipients:

- exactly one selected ID renders one full-width pane;
- two to four selected IDs render the existing resizable split-pane layout;
- the selection cannot become empty;
- selecting a fifth site is ignored while the existing four selections remain unchanged;
- pane order follows selection order.

The site picker moves into the left side of the expanded composer, matching `packages/server/app/web/AiHubPane.tsx`: a compact `N 个 AI` button with a chevron opens an upward listbox. Each site row has a visible selected indicator and remains open while the user toggles multiple sites. Clicking outside or pressing Escape closes it.

`添加站点` moves to the bottom of the same picker. Its existing name and URL form opens inside the picker, and custom-site deletion remains available on the corresponding custom row. The pane header keeps refresh and close actions; closing a pane removes it from `selectedIds` only when at least one other pane remains.

The composer remains expanded so the selector is always reachable. The old collapsed-bar state and its `收起` control are removed. The current broadcast implementation continues to send to `selectedIds` without a separate layout mode conversion.

## Data Flow

1. The renderer calculates pane rectangles and sends `hub:set-bounds`.
2. The main process stores the rectangles even if a view does not yet exist.
3. `hub:open` creates the view and immediately attaches it using the stored rectangle.
4. Selecting one site produces one full pane; selecting additional sites produces the existing resizable split layout.
5. The same ordered selection is passed to `hub:broadcast`.
6. Normal provider pages load with Electron's truthful browser identity.
7. A Google authentication navigation is cancelled before it enters the embedded view.
8. The configured provider page opens in the system browser and the renderer receives `google-auth-external`.
9. Embedded sites that are already logged in or use provider-supported direct login continue participating in broadcast.

## Error Handling

- Invalid or non-HTTPS Google-like URLs are not treated as supported Google authentication URLs.
- Failure from `shell.openExternal` is logged and reported through the existing load-failure/error surface without exposing credentials or URL query parameters.
- Repeated authentication clicks reuse the same deterministic policy and do not mutate session cookies.
- Existing `did-fail-load` handling continues ignoring cancelled navigation error `-3`.

## Testing

- Unit-test retained bounds for both orderings: bounds-before-open and open-before-bounds, plus clearing the layout.
- Unit-test the Google authentication URL policy against valid Google Accounts URLs, non-HTTPS URLs, and lookalike domains.
- Update renderer tests to require the dedicated event and user-facing email-login guidance, and to reject title-based detection.
- Test that the desktop renderer has no fixed site sidebar or explicit layout tabs, exposes the composer listbox, preserves at least one selection, caps selection at four, and derives both pane count and broadcast recipients from the same selection.
- Run desktop AI Hub tests and the desktop TypeScript compilation.
- Restart the existing desktop development process and verify the selector at desktop and narrow window sizes, including one-site full view and two-to-four-site splits.
- Verify first selection for Gemini, Grok, and ChatGPT displays without refresh.
- Verify a Google login attempt opens the provider in the system browser, leaves the embedded view out of the blocked login page, and does not break broadcast for embedded logged-in sites.

## Security Boundaries

- The application does not spoof a trusted browser identity.
- The application does not collect, copy, decrypt, or synchronize external-browser cookies or credentials.
- The application does not promise Google authentication inside Electron.
- Custom-site support remains limited to normalized HTTP/HTTPS URLs and existing sandboxed `WebContentsView` behavior.
