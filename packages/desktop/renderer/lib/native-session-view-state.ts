export interface NativeSessionViewState {
  agentType?: "customer-agent" | "codex" | "claude-code" | "opencode";
  status?: "idle" | "running" | "completed" | "failed";
  occupancy?: "available" | "owned-by-customer-agent" | "owned-externally";
}

export function isNativeRuntimeSelection(
  session: NativeSessionViewState | null | undefined,
  activeAgentType: NonNullable<NativeSessionViewState["agentType"]>,
): boolean {
  return (session?.agentType ?? activeAgentType) !== "customer-agent";
}

export function isActiveNativeSession(session: NativeSessionViewState | null | undefined): boolean {
  return session?.agentType !== undefined
    && session.agentType !== "customer-agent"
    && session.status === "running";
}

export function isObservedNativeRun(session: NativeSessionViewState | null | undefined): boolean {
  return isActiveNativeSession(session) && session?.occupancy === "owned-externally";
}

export function shouldRestoreLocalNativeRun(session: NativeSessionViewState | null | undefined): boolean {
  return isActiveNativeSession(session) && session?.occupancy !== "owned-externally";
}

export function shouldQueueMessageForActiveRun(
  session: NativeSessionViewState | null | undefined,
  isLocallyRunning: boolean,
): boolean {
  return isLocallyRunning || shouldRestoreLocalNativeRun(session);
}

export function shouldFollowNativeHistory(
  session: NativeSessionViewState | null | undefined,
  targetSessionId: string | null,
  runningSessionId: string | null,
): boolean {
  if (!targetSessionId || !session || session.agentType === "customer-agent") return false;
  return session.occupancy === "owned-externally" || runningSessionId !== targetSessionId;
}
