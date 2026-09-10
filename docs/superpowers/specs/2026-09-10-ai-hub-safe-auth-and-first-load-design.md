# AI Hub Safe Authentication and First-Load Design

## Goal

Fix AI Hub panes that remain blank until a manual refresh, remove browser-identity spoofing, and handle Google authentication without attempting to bypass Google's embedded-browser policy.

## Scope

- DeepSeek, ChatGPT, Gemini, Grok, and custom sites must render on the first selection without requiring refresh.
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

## Data Flow

1. The renderer calculates pane rectangles and sends `hub:set-bounds`.
2. The main process stores the rectangles even if a view does not yet exist.
3. `hub:open` creates the view and immediately attaches it using the stored rectangle.
4. Normal provider pages load with Electron's truthful browser identity.
5. A Google authentication navigation is cancelled before it enters the embedded view.
6. The configured provider page opens in the system browser and the renderer receives `google-auth-external`.
7. Embedded sites that are already logged in or use provider-supported direct login continue participating in broadcast.

## Error Handling

- Invalid or non-HTTPS Google-like URLs are not treated as supported Google authentication URLs.
- Failure from `shell.openExternal` is logged and reported through the existing load-failure/error surface without exposing credentials or URL query parameters.
- Repeated authentication clicks reuse the same deterministic policy and do not mutate session cookies.
- Existing `did-fail-load` handling continues ignoring cancelled navigation error `-3`.

## Testing

- Unit-test retained bounds for both orderings: bounds-before-open and open-before-bounds, plus clearing the layout.
- Unit-test the Google authentication URL policy against valid Google Accounts URLs, non-HTTPS URLs, and lookalike domains.
- Update renderer tests to require the dedicated event and user-facing email-login guidance, and to reject title-based detection.
- Run desktop AI Hub tests and the desktop TypeScript compilation.
- Restart the existing desktop development process and verify first selection for Gemini, Grok, and ChatGPT displays without refresh.
- Verify a Google login attempt opens the provider in the system browser, leaves the embedded view out of the blocked login page, and does not break broadcast for embedded logged-in sites.

## Security Boundaries

- The application does not spoof a trusted browser identity.
- The application does not collect, copy, decrypt, or synchronize external-browser cookies or credentials.
- The application does not promise Google authentication inside Electron.
- Custom-site support remains limited to normalized HTTP/HTTPS URLs and existing sandboxed `WebContentsView` behavior.
