export type LiveViewSource = "ego-browser" | "codex-browser" | "desktop";
export type LiveViewTransport = "cdp-jpeg-ws" | "webrtc";
export type LiveViewAvailability = "starting" | "ready" | "unavailable";
export type LiveViewOwnershipState =
  | "agent-controlled"
  | "handoff-requested"
  | "user-controlled"
  | "return-requested"
  | "resyncing";

export interface LiveViewViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/** A capture display the producer offers for desktop live sessions. */
export interface LiveViewDisplayOption {
  id: string;
  label: string;
  primary: boolean;
  selected: boolean;
}

export interface LiveViewSessionView {
  id: string;
  backend: LiveViewSource;
  browserSessionId?: string;
  agentSessionId?: string;
  title: string;
  url: string;
  viewport: LiveViewViewport | null;
  transport: LiveViewTransport;
  availability: LiveViewAvailability;
  capabilityError?: string;
  capabilityErrorCode?: string;
  state: LiveViewOwnershipState;
  online: boolean;
  frameSequence: number;
  updatedAt: number;
  viewerCount: number;
  isController: boolean;
  controlledByAnotherViewer: boolean;
  /** Multi-display Macs publish the selectable capture screens; null = single display. */
  displays?: LiveViewDisplayOption[] | null;
  /** Producer OS (process.platform), lets clients tailor system actions. */
  platform?: string;
  /** Full-duplex voice features implemented by this producer. */
  audioCapabilities?: import("./remote-audio.js").RemoteAudioCapabilities;
}

export type LiveViewInput =
  | {
      kind: "pointer";
      action: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      deltaX: number;
      deltaY: number;
      /** Mouse click count for double-click semantics (2 = double-click). */
      click?: number;
    }
  | {
      kind: "key";
      action: "down" | "up";
      key: string;
      code: string;
      text: string;
      modifiers: Array<"Alt" | "Control" | "Meta" | "Shift">;
    };

export interface LiveViewEvent extends Record<string, unknown> {
  type: string;
}

/** Transport-agnostic peer port implemented by WebSocket infrastructure. */
export interface LiveViewPeer {
  id: string;
  userId: string;
  send(event: LiveViewEvent): void;
  producerSessionIds: Set<string>;
  watchedSessionId: string | null;
}
