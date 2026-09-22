import { describe, expect, it } from "vitest";
import { RemoteAudioSession, type RemoteAudioCapabilities } from "./remote-audio";

const capabilities: RemoteAudioCapabilities = {
  fullDuplex: true,
  systemAudio: true,
  microphonePlayback: true,
  selfPlaybackExclusion: true,
};

describe("RemoteAudioSession", () => {
  it("starts only for the foreground controller", () => {
    const audio = new RemoteAudioSession(capabilities, { controller: true, foreground: true });
    expect(audio.dispatch({ type: "start" })).toMatchObject({ accepted: true, snapshot: { state: "starting" } });
    expect(audio.dispatch({ type: "connected" })).toMatchObject({ snapshot: { state: "live" } });
  });

  it("rejects viewers and background pages", () => {
    const viewer = new RemoteAudioSession(capabilities, { controller: false });
    expect(viewer.dispatch({ type: "start" })).toMatchObject({ accepted: false, reason: "not-controller" });
    viewer.dispatch({ type: "set-controller", controller: true });
    viewer.dispatch({ type: "set-foreground", foreground: false });
    expect(viewer.dispatch({ type: "start" })).toMatchObject({ accepted: false, reason: "background" });
  });

  it("stops when foreground or control is lost and never auto-resumes", () => {
    const audio = new RemoteAudioSession(capabilities, { controller: true });
    audio.dispatch({ type: "start" });
    audio.dispatch({ type: "connected" });
    expect(audio.dispatch({ type: "set-foreground", foreground: false })).toMatchObject({ snapshot: { state: "idle" } });
    expect(audio.dispatch({ type: "set-foreground", foreground: true })).toMatchObject({ snapshot: { state: "idle" } });
    audio.dispatch({ type: "start" });
    expect(audio.dispatch({ type: "set-controller", controller: false })).toMatchObject({ snapshot: { state: "idle" } });
  });

  it("tracks microphone and speaker mute independently", () => {
    const audio = new RemoteAudioSession(capabilities, { controller: true });
    audio.dispatch({ type: "set-microphone-muted", muted: true });
    expect(audio.dispatch({ type: "set-speaker-muted", muted: true })).toMatchObject({
      snapshot: { microphoneMuted: true, speakerMuted: true },
    });
    expect(audio.dispatch({ type: "set-microphone-muted", muted: false })).toMatchObject({
      snapshot: { microphoneMuted: false, speakerMuted: true },
    });
  });

  it("reports failure and makes repeated stop idempotent", () => {
    const audio = new RemoteAudioSession(capabilities, { controller: true });
    audio.dispatch({ type: "start" });
    expect(audio.dispatch({ type: "failed", error: "loopback unavailable" })).toMatchObject({
      snapshot: { state: "failed", error: "loopback unavailable" },
    });
    expect(audio.dispatch({ type: "stop" })).toMatchObject({ snapshot: { state: "idle" } });
    expect(audio.dispatch({ type: "stop" })).toMatchObject({ snapshot: { state: "idle" } });
  });

  it("rejects incomplete producer capabilities", () => {
    const audio = new RemoteAudioSession({ ...capabilities, selfPlaybackExclusion: false }, { controller: true });
    expect(audio.dispatch({ type: "start" })).toMatchObject({ accepted: false, reason: "unsupported" });
  });
});
