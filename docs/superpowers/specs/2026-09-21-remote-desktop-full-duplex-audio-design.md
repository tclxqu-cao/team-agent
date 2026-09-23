# Remote Desktop Full-Duplex Audio Design

## Goal

Add explicit, foreground-only full-duplex audio to the existing WebApp remote desktop experience on macOS and Windows. The computer sends system playback audio to the controlling WebApp, while the WebApp microphone is played through the computer's default output device.

## Confirmed Product Behavior

- Audio is off when remote desktop opens.
- Only the active controller can click **Start voice** and publish a microphone track.
- Starting voice requests browser microphone permission with echo cancellation, noise suppression, and automatic gain control enabled.
- Computer system audio and WebApp microphone audio run simultaneously.
- The WebApp exposes independent microphone and speaker mute controls.
- Leaving the foreground, losing control, closing the panel, changing sessions, or losing the connection stops microphone capture and desktop audio playback immediately.
- Returning to the foreground never restarts capture automatically; the user clicks **Start voice** again.
- Watch-only clients never publish microphone audio.
- The desktop capture path excludes or suppresses AgentRoam's own remote-microphone playback so that it is not returned as system audio.
- macOS and Windows use the same domain contract and UI behavior.

## Architecture

### Domain

`packages/core/src/domain/live-view/remote-audio.ts` owns the transport-independent vocabulary and state transitions:

- `RemoteAudioCapabilities`
- `RemoteAudioState`
- `RemoteAudioAction`
- `RemoteAudioSession`

The domain enforces explicit start, controller-only publishing, foreground-only capture, and terminal cleanup. It has no browser, Electron, WebRTC, or operating-system dependencies.

Live-view session metadata carries `audioCapabilities`. The registry validates and projects that value to viewers. Existing sessions without the field remain compatible and do not show voice controls.

### Application

The CLI `RemoteAuthorization` application service publishes full-duplex capability for native remote-desktop sessions on macOS and Windows. Existing control ownership remains authoritative: audio signaling is rejected unless the sender owns the session, and microphone frames are rejected until that controller explicitly starts voice.

The renderer `BrowserLivePanel` coordinates the viewer side:

1. User clicks **Start voice**.
2. The browser obtains a microphone stream.
3. The viewer sends `audio-start` through the existing bounded media-signaling channel.
4. The native helper starts OS system-audio capture while excluding its own process tree.
5. Browser microphone PCM is forwarded to the helper for local speaker playback while bounded system PCM returns to the WebApp.
6. Remote system audio is scheduled through a foreground Web Audio context.

Stopping voice stops every local microphone track and AudioContext, tells the producer to stop capture/playback, and leaves the video peer alive.

### Infrastructure

The native remote helpers own operating-system media mechanics:

- macOS uses ScreenCaptureKit audio with `excludesCurrentProcessAudio=true` and AVAudioEngine playback in the same helper process.
- Windows build 20348 and newer uses WASAPI process-loopback capture in exclude-target-process-tree mode and waveOut playback in that excluded helper process. Older Windows 10 builds keep remote desktop support but do not advertise full-duplex audio.
- Initial screen/video capture remains audio-off. `audio-start` and `audio-stop` affect audio resources without replacing the WebRTC video peer.
- Browser echo cancellation, noise suppression, and automatic gain control remain enabled at the viewer boundary.

No Cookie, credential, recording, or PCM data is persisted.

### Signaling

The existing `browser:webrtc` channel gains bounded messages:

- Viewer to producer: `audio-start`, `audio-stop`, `audio-microphone`
- Producer to viewer: `audio-state`, `audio-system`

`audio-state` carries `idle | starting | live | failed` and an optional bounded error. Audio frames are bounded signed 16-bit PCM chunks; SDP and ICE continue to carry video through the existing offer/answer path.

## Error Handling

- Microphone denial leaves video/control active and displays a localized error.
- Missing loopback support returns `audio-state: failed`; it never falls back to uploading microphone audio without downlink system audio.
- A native audio-start failure stops both audio directions but preserves the video peer.
- Session/control/visibility cleanup is idempotent.
- AudioContext startup failure is surfaced and voice is stopped rather than presenting a false live state.

## Security And Privacy

- Voice activation requires a user gesture.
- Only the current controller may send `audio-start` or microphone PCM, and PCM is rejected before explicit start.
- Capture ends on hidden-page transition and is not restored automatically.
- Microphone streams and system audio are never recorded or written to disk.
- Existing authenticated WebSocket and pairing paths carry bounded audio; ICE and TURN continue to carry video.

## Verification

- Domain tests cover explicit start, ownership, foreground suspension, mute state, failure, and idempotent stop.
- Registry and signal-parser tests cover capability projection and controller-only audio messages.
- Browser panel tests verify visible controls, PCM conversion, media constraints, capability gating, and foreground cleanup.
- Native helper builds verify ScreenCaptureKit/AVAudioEngine and WASAPI/waveOut integration; manager tests verify audio events remain separate from command replies.
- Core, desktop, WebApp, and server builds must pass.
- Runtime acceptance requires one macOS and one Windows session with audible computer output on the WebApp, audible WebApp microphone on the computer, independent mute controls, no self-echo loop, and immediate stop on backgrounding.
