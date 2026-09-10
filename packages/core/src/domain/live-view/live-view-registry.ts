import type {
  LiveViewAvailability,
  LiveViewInput,
  LiveViewPeer,
  LiveViewSessionView,
  LiveViewOwnershipState,
  LiveViewSource,
  LiveViewTransport,
  LiveViewViewport,
} from "./entities.js";

const OWNERSHIP_STATES = new Set<LiveViewOwnershipState>([
  "agent-controlled", "handoff-requested", "user-controlled", "return-requested", "resyncing",
]);
const SOURCES = new Set<LiveViewSource>(["ego-browser", "codex-browser", "desktop"]);
const AVAILABILITY_STATES = new Set<LiveViewAvailability>(["starting", "ready", "unavailable"]);
const MAX_FRAME_BYTES = 640 * 1024;

interface LiveFrame {
  [key: string]: unknown;
  type: "browser:frame";
  sessionId: string;
  sequence: number;
  data: Uint8Array;
  mime: "image/jpeg";
  viewport: LiveViewViewport | null;
  title: string;
  url: string;
  timestamp: number;
}

interface LiveSession {
  id: string;
  userId: string;
  producerId: string;
  producer: LiveViewPeer;
  watchers: Set<LiveViewPeer>;
  controllerId: string | null;
  latestFrame: LiveFrame | null;
  frameSequence: number;
  createdAt: number;
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
  updatedAt: number;
}

export interface PublishLiveSession {
  sessionId: unknown;
  backend: unknown;
  browserSessionId?: unknown;
  agentSessionId?: unknown;
  title?: unknown;
  url?: unknown;
  viewport?: unknown;
  transport?: unknown;
  state?: unknown;
  availability?: unknown;
  capabilityError?: unknown;
  capabilityErrorCode?: unknown;
}

function domainError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function requiredString(value: unknown, name: string, maxLength = 160): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) throw domainError(`invalid ${name}`, "EINVAL");
  return normalized;
}

function optionalString(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function defaultTitle(source: LiveViewSource): string {
  return source === "desktop" ? "桌面屏幕" : "浏览器";
}

function view(session: LiveSession, peer?: LiveViewPeer): LiveViewSessionView {
  return {
    id: session.id,
    backend: session.backend,
    browserSessionId: session.browserSessionId,
    agentSessionId: session.agentSessionId,
    title: session.title,
    url: session.url,
    viewport: session.viewport,
    transport: session.transport,
    availability: session.availability,
    capabilityError: session.capabilityError,
    capabilityErrorCode: session.capabilityErrorCode,
    state: session.state,
    online: session.online,
    frameSequence: session.frameSequence,
    updatedAt: session.updatedAt,
    viewerCount: session.watchers.size,
    isController: session.controllerId === peer?.id,
    controlledByAnotherViewer: Boolean(session.controllerId && session.controllerId !== peer?.id),
  };
}

export class LiveViewRegistry {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly peers = new Set<LiveViewPeer>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  connect(peer: LiveViewPeer): void {
    this.peers.add(peer);
  }

  list(peer: LiveViewPeer): LiveViewSessionView[] {
    return [...this.sessions.values()]
      .filter((session) => session.userId === peer.userId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => view(session, peer));
  }

  publish(peer: LiveViewPeer, input: PublishLiveSession): LiveViewSessionView {
    const id = requiredString(input.sessionId, "sessionId", 120);
    const backend = requiredString(input.backend, "backend", 40) as LiveViewSource;
    if (!SOURCES.has(backend)) throw domainError("unsupported live source", "EBACKEND");
    const existing = this.sessions.get(id);
    if (existing && existing.producerId !== peer.id) throw domainError("browser session already has a producer", "ESESSIONOWNED");
    const timestamp = this.now();
    const session: LiveSession = existing ?? {
      id,
      userId: peer.userId,
      producerId: peer.id,
      producer: peer,
      watchers: new Set(),
      controllerId: null,
      latestFrame: null,
      frameSequence: 0,
      createdAt: timestamp,
      backend,
      title: defaultTitle(backend),
      url: "",
      viewport: null,
      transport: "cdp-jpeg-ws",
      availability: "starting",
      state: "agent-controlled",
      online: true,
      updatedAt: timestamp,
    };
    session.backend = backend;
    session.browserSessionId = optionalString(input.browserSessionId, 160);
    session.agentSessionId = optionalString(input.agentSessionId, 240);
    session.title = optionalString(input.title, 300) ?? session.title;
    session.url = optionalString(input.url, 2_048) ?? session.url;
    session.viewport = normalizeViewport(input.viewport) ?? session.viewport;
    session.transport = input.transport === "webrtc" ? "webrtc" : "cdp-jpeg-ws";
    session.availability = AVAILABILITY_STATES.has(input.availability as LiveViewAvailability)
      ? input.availability as LiveViewAvailability
      : session.availability;
    session.capabilityError = optionalString(input.capabilityError, 500);
    session.capabilityErrorCode = optionalString(input.capabilityErrorCode, 80);
    if (session.availability !== "unavailable") {
      session.capabilityError = undefined;
      session.capabilityErrorCode = undefined;
    }
    session.state = OWNERSHIP_STATES.has(input.state as LiveViewOwnershipState)
      ? input.state as LiveViewOwnershipState
      : session.state;
    session.online = true;
    session.producer = peer;
    session.producerId = peer.id;
    session.updatedAt = timestamp;
    this.sessions.set(id, session);
    peer.producerSessionIds.add(id);
    this.announce(session, "browser:session");
    return view(session, peer);
  }

  updateFrame(peer: LiveViewPeer, input: Record<string, unknown>): { accepted: true; sequence: number } {
    const session = this.requireProducer(peer, input.sessionId);
    const data = input.data;
    if (!(data instanceof Uint8Array) || data.byteLength < 16 || data.byteLength > MAX_FRAME_BYTES) {
      throw domainError("browser frame is outside the allowed size", "EFRAME");
    }
    const sequence = Number.isSafeInteger(input.sequence) && Number(input.sequence) > session.frameSequence
      ? Number(input.sequence)
      : session.frameSequence + 1;
    session.frameSequence = sequence;
    session.title = optionalString(input.title, 300) ?? session.title;
    session.url = optionalString(input.url, 2_048) ?? session.url;
    session.viewport = normalizeViewport(input.viewport) ?? session.viewport;
    session.updatedAt = this.now();
    session.latestFrame = { type: "browser:frame", sessionId: session.id, sequence, data, mime: "image/jpeg", viewport: session.viewport, title: session.title, url: session.url, timestamp: session.updatedAt };
    const becameReady = session.availability !== "ready";
    session.availability = "ready";
    session.capabilityError = undefined;
    session.capabilityErrorCode = undefined;
    if (becameReady) this.announce(session, "browser:state");
    for (const watcher of session.watchers) watcher.send(session.latestFrame);
    return { accepted: true, sequence };
  }

  watch(peer: LiveViewPeer, sessionId: unknown): LiveViewSessionView {
    const session = this.requireVisible(peer, sessionId);
    this.unwatch(peer);
    session.watchers.add(peer);
    peer.watchedSessionId = session.id;
    session.updatedAt = this.now();
    if (session.latestFrame) queueMicrotask(() => peer.send(session.latestFrame!));
    this.announce(session, "browser:state");
    return view(session, peer);
  }

  unwatch(peer: LiveViewPeer): { unwatched: boolean } {
    const id = peer.watchedSessionId;
    if (!id) return { unwatched: false };
    const session = this.sessions.get(id);
    if (session) {
      session.watchers.delete(peer);
      if (session.controllerId === peer.id) this.releaseController(session, "controller-disconnected");
      this.announce(session, "browser:state");
    }
    peer.watchedSessionId = null;
    return { unwatched: true };
  }

  takeOver(peer: LiveViewPeer, sessionId: unknown): LiveViewSessionView {
    const session = this.requireVisible(peer, sessionId);
    if (!session.online) throw domainError("browser producer is offline", "EOFFLINE");
    if (session.availability !== "ready") throw domainError(session.capabilityError || "browser live stream is not ready", "ECAPABILITY");
    if (session.controllerId && session.controllerId !== peer.id) throw domainError("browser is controlled by another viewer", "EWRITELOCK");
    if (session.controllerId === peer.id && session.state !== "agent-controlled") return view(session, peer);
    session.watchers.add(peer);
    peer.watchedSessionId = session.id;
    session.controllerId = peer.id;
    session.state = "handoff-requested";
    session.updatedAt = this.now();
    session.producer.send({ type: "browser:takeover-requested", sessionId: session.id });
    this.announce(session, "browser:state");
    return view(session, peer);
  }

  returnControl(peer: LiveViewPeer, sessionId: unknown): LiveViewSessionView {
    const session = this.requireVisible(peer, sessionId);
    if (session.controllerId !== peer.id) throw domainError("only the active controller can return control", "EWRITELOCK");
    if (session.state === "return-requested" || session.state === "resyncing") return view(session, peer);
    session.state = "return-requested";
    session.updatedAt = this.now();
    session.producer.send({ type: "browser:return-requested", sessionId: session.id });
    this.announce(session, "browser:state");
    return view(session, peer);
  }

  input(peer: LiveViewPeer, sessionId: unknown, rawInput: unknown): void {
    const session = this.requireVisible(peer, sessionId);
    if (session.controllerId !== peer.id || session.state !== "user-controlled") throw domainError("browser is read-only", "EWRITELOCK");
    session.producer.send({ type: "browser:input", sessionId: session.id, input: normalizeInput(rawInput) });
  }

  producerState(peer: LiveViewPeer, sessionId: unknown, state: unknown): LiveViewSessionView {
    const session = this.requireProducer(peer, sessionId);
    if (!OWNERSHIP_STATES.has(state as LiveViewOwnershipState)) throw domainError("invalid browser ownership state", "EINVAL");
    if (state === "user-controlled" && !session.controllerId) throw domainError("no viewer requested control", "EINVAL");
    session.state = state as LiveViewOwnershipState;
    if (state === "agent-controlled") session.controllerId = null;
    session.updatedAt = this.now();
    this.announce(session, "browser:state");
    return view(session, peer);
  }

  close(peer: LiveViewPeer, sessionId: unknown): void {
    const session = this.requireProducer(peer, sessionId);
    for (const connectedPeer of this.peers) {
      if (connectedPeer.userId !== session.userId) continue;
      connectedPeer.send({ type: "browser:closed", session: view(session, connectedPeer), reason: "producer-closed" });
      if (connectedPeer.watchedSessionId === session.id) connectedPeer.watchedSessionId = null;
    }
    peer.producerSessionIds.delete(session.id);
    this.sessions.delete(session.id);
  }

  disconnect(peer: LiveViewPeer): void {
    this.unwatch(peer);
    for (const id of peer.producerSessionIds) {
      const session = this.sessions.get(id);
      if (!session || session.producerId !== peer.id) continue;
      for (const connectedPeer of this.peers) {
        if (connectedPeer.userId !== session.userId) continue;
        connectedPeer.send({ type: "browser:closed", session: view(session, connectedPeer), reason: "producer-disconnected" });
        if (connectedPeer.watchedSessionId === session.id) connectedPeer.watchedSessionId = null;
      }
      this.sessions.delete(id);
    }
    peer.producerSessionIds.clear();
    this.peers.delete(peer);
  }

  private announce(session: LiveSession, type: string): void {
    for (const connectedPeer of this.peers) {
      if (connectedPeer.userId === session.userId) connectedPeer.send({ type, session: view(session, connectedPeer) });
    }
  }

  private releaseController(session: LiveSession, reason: string): void {
    if (!session.controllerId) return;
    session.controllerId = null;
    session.state = "return-requested";
    session.updatedAt = this.now();
    session.producer.send({ type: "browser:return-requested", sessionId: session.id, reason });
  }

  private requireVisible(peer: LiveViewPeer, rawId: unknown): LiveSession {
    const id = requiredString(rawId, "sessionId", 120);
    const session = this.sessions.get(id);
    if (!session || session.userId !== peer.userId) throw domainError("browser session not found", "ENOENT");
    return session;
  }

  private requireProducer(peer: LiveViewPeer, rawId: unknown): LiveSession {
    const session = this.requireVisible(peer, rawId);
    if (session.producerId !== peer.id) throw domainError("browser producer mismatch", "EWRITELOCK");
    return session;
  }
}

function normalizeViewport(value: unknown): LiveViewViewport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const width = Math.floor(Number(candidate.width));
  const height = Math.floor(Number(candidate.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 10_000 || height > 10_000) return null;
  return { width, height, deviceScaleFactor: Math.max(0.1, Math.min(8, Number(candidate.deviceScaleFactor) || 1)) };
}

function normalizeInput(value: unknown): LiveViewInput {
  if (!value || typeof value !== "object") throw domainError("invalid browser input", "EINVAL");
  const input = value as Record<string, unknown>;
  if (input.kind === "pointer") {
    const x = Number(input.x);
    const y = Number(input.y);
    const action = ["down", "up", "move", "wheel"].includes(String(input.action))
      ? input.action as "down" | "up" | "move" | "wheel"
      : null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || !action) throw domainError("invalid pointer input", "EINVAL");
    return { kind: "pointer", action, x, y, button: ["left", "right", "middle"].includes(String(input.button)) ? input.button as "left" | "right" | "middle" : "left", deltaX: Math.max(-2_000, Math.min(2_000, Number(input.deltaX) || 0)), deltaY: Math.max(-2_000, Math.min(2_000, Number(input.deltaY) || 0)) };
  }
  if (input.kind === "key") {
    const allowedModifiers = new Set(["Alt", "Control", "Meta", "Shift"] as const);
    return { kind: "key", action: input.action === "up" ? "up" : "down", key: optionalString(input.key, 40) ?? "", code: optionalString(input.code, 40) ?? "", text: optionalString(input.text, 2_000) ?? "", modifiers: Array.isArray(input.modifiers) ? input.modifiers.filter((item): item is "Alt" | "Control" | "Meta" | "Shift" => allowedModifiers.has(item as never)).slice(0, 4) : [] };
  }
  throw domainError("unsupported browser input", "EINVAL");
}
