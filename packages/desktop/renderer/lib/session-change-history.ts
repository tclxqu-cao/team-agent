import type { AgentApi } from "../global";
import { collectTurnChanges, restoreOmittedPatchFiles, type TurnFileChange } from "./session-turn-results";
import { restoreCodexExecutionTrace, restoreSessionHistoryPage, type SessionHistoryDetail } from "./session-history";

export async function loadSessionChangeHistory(api: Pick<AgentApi, "getSession" | "getSessionToolResult">, sessionId: string, workspacePath: string | null, signal: AbortSignal): Promise<TurnFileChange[]> {
  const seenCursors = new Set<string>();
  const seenTurns = new Set<string>();
  const pages: TurnFileChange[][] = [];
  let cursor: string | undefined;
  let revision: string | undefined;
  do {
    signal.throwIfAborted();
    // Codex can return a page of tools with result bodies kept behind lazy refs.
    const page = await api.getSession(sessionId, { before: cursor, limit: 100, view: "trace" }, { signal }) as SessionHistoryDetail | null;
    signal.throwIfAborted();
    if (!page || page.id !== sessionId || !Array.isArray(page.messages)) throw new Error("当前会话记录不可用");
    if (cursor && revision !== page.history?.revision) throw new Error("会话内容已更新，请重试");
    revision = page.history?.revision;
    const messages = restoreSessionHistoryPage(page);
    const changes: TurnFileChange[] = [];
    const resolved = [] as typeof messages;
    for (const message of messages) {
      const trace = message.executionTrace;
      if (!trace) {
        resolved.push(message);
      } else if (!seenTurns.has(trace.turnId)) {
        // Mixed-engine history carries frozen traces in its core page.
        seenTurns.add(trace.turnId);
        const detail = await api.getSession(sessionId, { view: "trace", turnId: trace.turnId, revision }, { signal }) as SessionHistoryDetail | null;
        signal.throwIfAborted();
        if (!detail || detail.history?.delivery !== "trace" || detail.history.revision !== revision) throw new Error("会话内容已更新，请重试");
        resolved.push(...restoreCodexExecutionTrace(detail));
      }
    }
    const populated = await restoreOmittedPatchFiles(resolved, async ref => {
      signal.throwIfAborted();
      return api.getSessionToolResult(sessionId, ref);
    });
    signal.throwIfAborted();
    let segment = [] as typeof messages;
    for (const message of populated) {
      if (message.role === "user" && !message.isSteered) {
        changes.push(...collectTurnChanges(segment, workspacePath));
        segment = [];
      }
      segment.push(message);
    }
    changes.push(...collectTurnChanges(segment, workspacePath));
    pages.push(changes);
    cursor = page.history?.nextCursor ?? undefined;
    if (!cursor && page.history?.hasMore) throw new Error("会话记录分页中断，请重试");
    if (cursor && seenCursors.has(cursor)) throw new Error("会话记录分页重复，请重试");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return pages.reverse().flat();
}
