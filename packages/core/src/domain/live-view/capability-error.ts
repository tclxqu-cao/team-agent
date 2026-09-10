/**
 * A live-view stream cannot be produced because a host capability is missing
 * (screen-recording permission gone, no capture source, no CDP screencast).
 * The code is part of the wire protocol (producer → registry → watcher) and
 * must stay stable: `BROWSER_LIVE_STREAM_UNAVAILABLE`.
 */
export class LiveViewCapabilityError extends Error {
  readonly code = "BROWSER_LIVE_STREAM_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "LiveViewCapabilityError";
  }
}
