import type { AgentApi, SessionMessageRunOptions, UnifiedSessionSummary } from "../global";

export interface ParallelMessage {
  sourceMessageId: string;
  content: string;
  images?: string[];
  agentIds?: string[];
  agentName?: string;
  runOptions?: SessionMessageRunOptions;
}
export interface FailedParallelMessage { member: UnifiedSessionSummary; message: ParallelMessage; error: string; blocked?: boolean }

/** A retry receives only failed attempts, with the same per-session receipt ID. */
export async function dispatchParallelMessages(
  attempts: Array<{ member: UnifiedSessionSummary; message: ParallelMessage }>,
  ports: {
    enqueue: AgentApi["enqueueSessionMessage"];
    prepare?: (member: UnifiedSessionSummary, message: ParallelMessage) => Promise<ParallelMessage>;
    admitted?: (member: UnifiedSessionSummary, state: Awaited<ReturnType<AgentApi["enqueueSessionMessage"]>>) => void;
  },
): Promise<{ accepted: string[]; failed: FailedParallelMessage[] }> {
  const prepared = attempts.map(attempt => ({ ...attempt }));
  const results = await Promise.allSettled(prepared.map(async attempt => {
    if (ports.prepare) attempt.message = await ports.prepare(attempt.member, attempt.message);
    const state = await ports.enqueue(attempt.member.id, attempt.message);
    ports.admitted?.(attempt.member, state);
  }));
  return {
    accepted: attempts.filter((_, index) => results[index].status === "fulfilled").map(attempt => attempt.member.id),
    failed: results.flatMap((result, index) => result.status === "rejected" ? [{
      ...prepared[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }] : []),
  };
}
