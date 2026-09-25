# Desktop Live CLI Reuse Design

- Date: 2026-09-25
- Status: approved, revised after locked-screen runtime evidence
- Baseline: `0f57620`
- Related: `2026-09-25-desktop-live-viewer-driven-display-wake-design.md`

## Problem

The Desktop app originally published `desktop:primary` with Electron
`desktopCapturer`. Viewer-driven display wake works while the Mac is unlocked,
but an already locked Mac still cannot be watched: after the display wakes,
Electron returns no capture sources while LoginWindow owns the screen.

The same locked Mac was tested with both backends. Electron returned zero
sources for 15 seconds, while the existing CLI ScreenCaptureKit helper captured
a 2560x1440 lock-screen frame immediately. Retrying Electron or adding more
display assertions cannot repair the capture backend.

## Decision

The Desktop app will reuse the CLI-owned native remote desktop service instead
of adding a second ScreenCaptureKit helper.

- `cli-desktop:primary` is the only local desktop live session.
- The CLI keeps ownership of ScreenCaptureKit, VideoToolbox/WebRTC, JPEG
  fallback, remote input, multi-display selection, and viewer lifecycle.
- Desktop settings proxy authorization actions and status through the selected
  `SharedServiceConnection` and `/api/remote-authorization`.
- Desktop no longer publishes `desktop:primary` or starts its Electron WebRTC
  capture window.
- Desktop's separate Computer Use relay remains unchanged; it is not a
  user-facing remote desktop producer.

This avoids two visible desktop sessions, duplicate TCC identities, competing
capture streams, and two implementations of the same media and input protocol.
Desktop already requires a selected shared CLI service for its application
data, so the proxy adds no new operational dependency.

## Viewer And Power Lifecycle

The CLI `RemoteAuthorization` remains the authority for viewer count:

1. Enabling sharing publishes a dormant, discoverable `cli-desktop:primary`
   session without starting native capture.
2. WebApp watch changes `viewerCount` from zero to positive.
3. The CLI runs `caffeinate -u` and starts a viewer-scoped `caffeinate -d`
   process before capture, so display wake and hold do not depend on capture
   permission or first-frame success. The native helper also declares user
   activity and posts a no-op HID mouse-move event when Accessibility is
   available.
4. ScreenCaptureKit captures LoginWindow and continues into the unlocked
   desktop without changing producer identity.
5. Three seconds after the final viewer leaves, the CLI stops capture and the
   helper exits, then terminates the viewer-scoped display assertion.

No viewer therefore means no ScreenCaptureKit stream and no display-sleep
assertion. The persisted sharing switch only controls discoverability.

## Desktop Control Plane

`DesktopLiveCliProxy` maps the CLI API to the existing renderer contract:

- `enabled` -> `enabled`
- `screen` -> `permissionScreen`
- `accessibility` -> `accessibilityTrusted`
- `online` -> `sessionOnline`
- CLI `controlState` -> Desktop control banner state

Enable, disable, permission authorization, recheck, and restart are POSTed to
the CLI API. A lightweight GET poll keeps the Desktop permission page and local
remote-control banner current without starting the helper.

Display selection is not duplicated in Desktop settings. The CLI publishes its
display list with the live session, and the WebApp viewer uses the existing
`browser:set-display` path.

## Locked State

The CLI helper's bridge `status` response includes the same
`CGSSessionScreenIsLocked` result already used by its diagnostic mode. This
keeps API status accurate while preserving the existing behavior: lock state
does not make macOS capture unavailable because ScreenCaptureKit can capture
LoginWindow.

FileVault pre-boot remains unsupported because the helper and CGEvent do not
run before LoginWindow.

## Failure Handling

- No selected shared service: Desktop surfaces the existing service connection
  gate; it does not start a fallback producer.
- Missing or outdated CLI helper: the CLI API returns its existing actionable
  error and Desktop displays it.
- Permission denial: authorization is requested under the CLI helper's TCC
  identity, which is the identity that performs capture and input.
- Poll failure: the last known Desktop status remains visible while the shared
  service reconnection UI handles transport recovery.

## Verification

- Unit test status mapping, action forwarding, poll coalescing, and server
  viewer/control status.
- Compile the CLI Swift helper, Desktop TypeScript, and Server production build.
- Confirm the live session list contains `cli-desktop:primary` and no
  `desktop:primary` after Desktop starts.
- End-to-end: lock the Mac, open the live session from WebApp, observe the
  LoginWindow frame over WebRTC, take control, enter the password, and observe
  the unlocked desktop without switching to a second producer.
- Close the final viewer and confirm the CLI helper exits after its idle delay
  and no AgentRoam `NoDisplaySleepAssertion` remains.
