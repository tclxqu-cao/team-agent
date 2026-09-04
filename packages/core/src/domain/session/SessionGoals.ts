export type SessionGoalStatus = "queued" | "active" | "completed" | "failed" | "cancelled";
export type SessionQueueItemKind = "goal" | "message";

export interface SessionMessagePayload {
  images?: string[];
  agentIds?: string[];
  agentName?: string;
}

export interface SessionGoal {
  id: string;
  sessionId: string;
  objective: string;
  status: SessionGoalStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
  sourceMessageId?: string;
  /** Missing on legacy records, where the item is always a goal. */
  kind?: SessionQueueItemKind;
  messagePayload?: SessionMessagePayload;
  iterations?: number;
  lastReason?: string;
}

export interface SessionGoalState {
  active: SessionGoal | null;
  queued: SessionGoal[];
  history: SessionGoal[];
}

export const EMPTY_SESSION_GOAL_STATE: SessionGoalState = {
  active: null,
  queued: [],
  history: [],
};

export const SESSION_GOAL_METADATA_KEY = "goalState";

export function readSessionGoalState(metadata: Record<string, unknown> | undefined): SessionGoalState {
  const value = metadata?.[SESSION_GOAL_METADATA_KEY];
  if (!value || typeof value !== "object") return cloneGoalState(EMPTY_SESSION_GOAL_STATE);
  const candidate = value as Partial<SessionGoalState>;
  const active = isSessionGoal(candidate.active) && candidate.active.status === "active"
    ? { ...candidate.active }
    : null;
  const queued = Array.isArray(candidate.queued)
    ? candidate.queued.filter(isSessionGoal).map((goal) => ({ ...goal, status: "queued" as const }))
    : [];
  const history = Array.isArray(candidate.history)
    ? candidate.history.filter(isSessionGoal).filter((goal) => goal.status !== "active" && goal.status !== "queued")
    : [];
  return normalizeGoalState({ active, queued, history });
}

export function writeSessionGoalState(
  metadata: Record<string, unknown> | undefined,
  state: SessionGoalState,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [SESSION_GOAL_METADATA_KEY]: normalizeGoalState(state),
  };
}

export function enqueueSessionGoal(
  state: SessionGoalState,
  input: {
    id: string;
    sessionId: string;
    objective: string;
    sourceMessageId?: string;
    now: number;
  },
): SessionGoalState {
  return enqueueSessionQueueItem(state, { ...input, kind: "goal" });
}

export function enqueueSessionMessage(
  state: SessionGoalState,
  input: {
    id: string;
    sessionId: string;
    objective: string;
    sourceMessageId: string;
    messagePayload?: SessionMessagePayload;
    now: number;
    activate: boolean;
  },
): SessionGoalState {
  return enqueueSessionQueueItem(state, { ...input, kind: "message" });
}

function enqueueSessionQueueItem(
  state: SessionGoalState,
  input: {
    id: string;
    sessionId: string;
    objective: string;
    sourceMessageId?: string;
    kind: SessionQueueItemKind;
    messagePayload?: SessionMessagePayload;
    now: number;
    activate?: boolean;
  },
): SessionGoalState {
  const objective = input.objective.trim();
  if (!objective) throw new Error(input.kind === "goal" ? "Goal objective is required" : "Message is required");
  if (input.kind === "goal" && objective.length > 4_000) {
    throw new Error("Goal objective must be at most 4000 characters");
  }
  const goal: SessionGoal = {
    id: input.id,
    sessionId: input.sessionId,
    objective,
    status: "queued",
    position: state.queued.length,
    createdAt: input.now,
    updatedAt: input.now,
    kind: input.kind,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.messagePayload ? { messagePayload: normalizeMessagePayload(input.messagePayload) } : {}),
  };
  const queued = input.kind === "goal"
    ? [...state.queued.filter((item) => sessionQueueItemKind(item) === "goal"), goal,
        ...state.queued.filter((item) => sessionQueueItemKind(item) === "message")]
    : [...state.queued, goal];
  const next = normalizeGoalState({
    active: state.active ? { ...state.active } : null,
    queued,
    history: [...state.history],
  });
  return !next.active && input.activate !== false
    ? promoteNextSessionQueueItem(next, input.now)
    : next;
}

export function reorderQueuedSessionGoals(state: SessionGoalState, orderedIds: readonly string[]): SessionGoalState {
  return reorderQueuedSessionItems(state, "goal", orderedIds);
}

export function reorderQueuedSessionMessages(state: SessionGoalState, orderedIds: readonly string[]): SessionGoalState {
  return reorderQueuedSessionItems(state, "message", orderedIds);
}

function reorderQueuedSessionItems(
  state: SessionGoalState,
  kind: SessionQueueItemKind,
  orderedIds: readonly string[],
): SessionGoalState {
  const current = state.queued.filter((item) => sessionQueueItemKind(item) === kind);
  const currentIds = current.map((item) => item.id);
  if (
    orderedIds.length !== currentIds.length
    || new Set(orderedIds).size !== currentIds.length
    || orderedIds.some((id) => !currentIds.includes(id))
  ) {
    throw new Error(`Queued ${kind} order must contain every queued ${kind} exactly once`);
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  let nextIndex = 0;
  return normalizeGoalState({
    active: state.active ? { ...state.active } : null,
    queued: state.queued.map((item) => sessionQueueItemKind(item) === kind
      ? { ...byId.get(orderedIds[nextIndex++])! }
      : { ...item }),
    history: [...state.history],
  });
}

export function updateQueuedSessionMessage(
  state: SessionGoalState,
  messageId: string,
  objective: string,
  messagePayload?: SessionMessagePayload,
  now: number = Date.now(),
): SessionGoalState {
  const content = objective.trim();
  if (!content) throw new Error("Message is required");
  let found = false;
  const queued = state.queued.map((item) => {
    if (item.id !== messageId || sessionQueueItemKind(item) !== "message") return { ...item };
    found = true;
    return {
      ...item,
      objective: content,
      messagePayload: normalizeMessagePayload(messagePayload ?? item.messagePayload),
      updatedAt: now,
    };
  });
  if (!found) throw new Error("Queued message not found");
  return normalizeGoalState({ active: state.active ? { ...state.active } : null, queued, history: [...state.history] });
}

export function queuedSessionMessages(state: SessionGoalState): SessionGoal[] {
  return state.queued
    .filter((item) => sessionQueueItemKind(item) === "message")
    .map((item) => ({ ...item }));
}

export function projectSessionGoals(state: SessionGoalState): SessionGoalState {
  return normalizeGoalState({
    active: state.active && sessionQueueItemKind(state.active) === "goal" ? { ...state.active } : null,
    queued: state.queued.filter((item) => sessionQueueItemKind(item) === "goal").map((item) => ({ ...item })),
    history: state.history.filter((item) => sessionQueueItemKind(item) === "goal").map((item) => ({ ...item })),
  });
}

export function sessionQueueItemKind(item: SessionGoal): SessionQueueItemKind {
  return item.kind === "message" ? "message" : "goal";
}

export function promoteNextSessionQueueItem(state: SessionGoalState, now: number): SessionGoalState {
  if (state.active || state.queued.length === 0) return normalizeGoalState(state);
  const goalIndex = state.queued.findIndex((item) => sessionQueueItemKind(item) === "goal");
  const nextIndex = goalIndex >= 0 ? goalIndex : 0;
  const next = state.queued[nextIndex];
  return normalizeGoalState({
    active: { ...next, status: "active", updatedAt: now },
    queued: state.queued.filter((_, index) => index !== nextIndex),
    history: [...state.history],
  });
}

export function finishActiveSessionGoal(
  state: SessionGoalState,
  outcome: "completed" | "failed" | "cancelled",
  now: number,
  lastReason?: string,
): SessionGoalState {
  if (!state.active) return normalizeGoalState(state);
  const finished: SessionGoal = {
    ...state.active,
    status: outcome,
    position: 0,
    updatedAt: now,
    ...(lastReason ? { lastReason } : {}),
  };
  return promoteNextSessionQueueItem(normalizeGoalState({
    active: null,
    queued: [...state.queued],
    history: sessionQueueItemKind(finished) === "goal"
      ? [...state.history, finished].slice(-100)
      : [...state.history],
  }), now);
}

export function cancelSessionGoal(state: SessionGoalState, goalId: string, now: number): SessionGoalState {
  if (state.active?.id === goalId) return finishActiveSessionGoal(state, "cancelled", now);
  const target = state.queued.find((goal) => goal.id === goalId);
  if (!target) return normalizeGoalState(state);
  return normalizeGoalState({
    active: state.active ? { ...state.active } : null,
    queued: state.queued.filter((goal) => goal.id !== goalId),
    history: sessionQueueItemKind(target) === "goal"
      ? [...state.history, { ...target, status: "cancelled" as const, position: 0, updatedAt: now }].slice(-100)
      : [...state.history],
  });
}

export function cancelQueuedSessionMessage(state: SessionGoalState, messageId: string): SessionGoalState {
  const target = state.queued.find((item) => (
    item.id === messageId && sessionQueueItemKind(item) === "message"
  ));
  if (!target) return normalizeGoalState(state);
  return normalizeGoalState({
    active: state.active ? { ...state.active } : null,
    queued: state.queued.filter((item) => item.id !== messageId),
    history: [...state.history],
  });
}

export function normalizeGoalObjective(value: string): string {
  return value.trim().replace(/^\/goal\s+/i, "").trim();
}

function normalizeGoalState(state: SessionGoalState): SessionGoalState {
  return {
    active: state.active ? normalizeItem({ ...state.active, status: "active", position: 0 }) : null,
    queued: state.queued.map((goal, position) => normalizeItem({ ...goal, status: "queued", position })),
    history: state.history.map((goal) => normalizeItem({ ...goal, position: 0 })),
  };
}

function cloneGoalState(state: SessionGoalState): SessionGoalState {
  return normalizeGoalState(state);
}

function isSessionGoal(value: unknown): value is SessionGoal {
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<SessionGoal>;
  return typeof goal.id === "string"
    && typeof goal.sessionId === "string"
    && typeof goal.objective === "string"
    && typeof goal.status === "string"
    && ["queued", "active", "completed", "failed", "cancelled"].includes(goal.status)
    && typeof goal.position === "number"
    && typeof goal.createdAt === "number"
    && typeof goal.updatedAt === "number";
}

function normalizeItem(item: SessionGoal): SessionGoal {
  const kind = sessionQueueItemKind(item);
  return {
    ...item,
    kind,
    ...(kind === "message" ? { messagePayload: normalizeMessagePayload(item.messagePayload) } : {}),
  };
}

function normalizeMessagePayload(payload: SessionMessagePayload | undefined): SessionMessagePayload {
  if (!payload) return {};
  return {
    ...(payload.images?.length ? { images: [...payload.images] } : {}),
    ...(payload.agentIds?.length ? { agentIds: [...payload.agentIds] } : {}),
    ...(payload.agentName ? { agentName: payload.agentName } : {}),
  };
}
