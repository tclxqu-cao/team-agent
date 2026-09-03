export type SessionGoalStatus = "queued" | "active" | "completed" | "failed" | "cancelled";

export interface SessionGoal {
  id: string;
  sessionId: string;
  objective: string;
  status: SessionGoalStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
  sourceMessageId?: string;
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
  const objective = input.objective.trim();
  if (!objective) throw new Error("Goal objective is required");
  if (objective.length > 4_000) throw new Error("Goal objective must be at most 4000 characters");
  const goal: SessionGoal = {
    id: input.id,
    sessionId: input.sessionId,
    objective,
    status: state.active ? "queued" : "active",
    position: state.active ? state.queued.length : 0,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
  };
  return normalizeGoalState({
    active: state.active ? { ...state.active } : goal,
    queued: state.active ? [...state.queued, goal] : [...state.queued],
    history: [...state.history],
  });
}

export function reorderQueuedSessionGoals(state: SessionGoalState, orderedIds: readonly string[]): SessionGoalState {
  const currentIds = state.queued.map((goal) => goal.id);
  if (
    orderedIds.length !== currentIds.length
    || new Set(orderedIds).size !== currentIds.length
    || orderedIds.some((id) => !currentIds.includes(id))
  ) {
    throw new Error("Queued goal order must contain every queued goal exactly once");
  }
  const byId = new Map(state.queued.map((goal) => [goal.id, goal]));
  return normalizeGoalState({
    active: state.active ? { ...state.active } : null,
    queued: orderedIds.map((id) => ({ ...byId.get(id)! })),
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
  const [next, ...rest] = state.queued;
  return normalizeGoalState({
    active: next ? { ...next, status: "active", position: 0, updatedAt: now } : null,
    queued: rest,
    history: [...state.history, finished].slice(-100),
  });
}

export function cancelSessionGoal(state: SessionGoalState, goalId: string, now: number): SessionGoalState {
  if (state.active?.id === goalId) return finishActiveSessionGoal(state, "cancelled", now);
  const target = state.queued.find((goal) => goal.id === goalId);
  if (!target) return normalizeGoalState(state);
  return normalizeGoalState({
    active: state.active ? { ...state.active } : null,
    queued: state.queued.filter((goal) => goal.id !== goalId),
    history: [...state.history, { ...target, status: "cancelled" as const, position: 0, updatedAt: now }].slice(-100),
  });
}

export function normalizeGoalObjective(value: string): string {
  return value.trim().replace(/^\/goal\s+/i, "").trim();
}

function normalizeGoalState(state: SessionGoalState): SessionGoalState {
  return {
    active: state.active ? { ...state.active, status: "active", position: 0 } : null,
    queued: state.queued.map((goal, position) => ({ ...goal, status: "queued", position })),
    history: state.history.map((goal) => ({ ...goal, position: 0 })),
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
