export interface RemoteAudioCapabilities {
  fullDuplex: boolean;
  systemAudio: boolean;
  microphonePlayback: boolean;
  selfPlaybackExclusion: boolean;
}

export type RemoteAudioState = "idle" | "starting" | "live" | "failed";

export interface RemoteAudioSnapshot {
  state: RemoteAudioState;
  microphoneMuted: boolean;
  speakerMuted: boolean;
  foreground: boolean;
  controller: boolean;
  error?: string;
}

export type RemoteAudioAction =
  | { type: "start" }
  | { type: "connected" }
  | { type: "stop" }
  | { type: "failed"; error: string }
  | { type: "set-microphone-muted"; muted: boolean }
  | { type: "set-speaker-muted"; muted: boolean }
  | { type: "set-foreground"; foreground: boolean }
  | { type: "set-controller"; controller: boolean };

export type RemoteAudioDispatchResult =
  | { accepted: true; snapshot: RemoteAudioSnapshot }
  | { accepted: false; reason: "unsupported" | "not-controller" | "background"; snapshot: RemoteAudioSnapshot };

function canStart(capabilities: RemoteAudioCapabilities): boolean {
  return capabilities.fullDuplex
    && capabilities.systemAudio
    && capabilities.microphonePlayback
    && capabilities.selfPlaybackExclusion;
}

/** Transport-independent full-duplex voice state for one remote controller. */
export class RemoteAudioSession {
  private snapshot: RemoteAudioSnapshot;

  constructor(
    private readonly capabilities: RemoteAudioCapabilities,
    initial: Partial<Pick<RemoteAudioSnapshot, "foreground" | "controller">> = {},
  ) {
    this.snapshot = {
      state: "idle",
      microphoneMuted: false,
      speakerMuted: false,
      foreground: initial.foreground ?? true,
      controller: initial.controller ?? false,
    };
  }

  getSnapshot(): RemoteAudioSnapshot {
    return { ...this.snapshot };
  }

  dispatch(action: RemoteAudioAction): RemoteAudioDispatchResult {
    if (action.type === "set-foreground") {
      this.snapshot = { ...this.snapshot, foreground: action.foreground };
      if (!action.foreground) this.toIdle();
      return this.accepted();
    }
    if (action.type === "set-controller") {
      this.snapshot = { ...this.snapshot, controller: action.controller };
      if (!action.controller) this.toIdle();
      return this.accepted();
    }
    if (action.type === "stop") {
      this.toIdle();
      return this.accepted();
    }
    if (action.type === "start") {
      if (!canStart(this.capabilities)) return this.rejected("unsupported");
      if (!this.snapshot.controller) return this.rejected("not-controller");
      if (!this.snapshot.foreground) return this.rejected("background");
      this.snapshot = { ...this.snapshot, state: "starting", error: undefined };
      return this.accepted();
    }
    if (action.type === "connected") {
      if (this.snapshot.state === "starting" && this.snapshot.controller && this.snapshot.foreground) {
        this.snapshot = { ...this.snapshot, state: "live", error: undefined };
      }
      return this.accepted();
    }
    if (action.type === "failed") {
      this.snapshot = { ...this.snapshot, state: "failed", error: action.error.slice(0, 500) };
      return this.accepted();
    }
    if (action.type === "set-microphone-muted") {
      this.snapshot = { ...this.snapshot, microphoneMuted: action.muted };
      return this.accepted();
    }
    this.snapshot = { ...this.snapshot, speakerMuted: action.muted };
    return this.accepted();
  }

  private toIdle(): void {
    this.snapshot = {
      ...this.snapshot,
      state: "idle",
      microphoneMuted: false,
      speakerMuted: false,
      error: undefined,
    };
  }

  private accepted(): RemoteAudioDispatchResult {
    return { accepted: true, snapshot: this.getSnapshot() };
  }

  private rejected(reason: "unsupported" | "not-controller" | "background"): RemoteAudioDispatchResult {
    return { accepted: false, reason, snapshot: this.getSnapshot() };
  }
}
