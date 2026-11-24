import type { AgentApi } from "../../../shared/src/contracts/agent-api";
import { collectTurnChanges, restoreOmittedPatchFiles, type TurnFileChange } from "./session-turn-results";
import { restoreCodexExecutionTrace, restoreSessionHistoryPage, type SessionHistoryDetail } from "./session-history";

type ChangeHistoryApi = Pick<AgentApi, "getSession" | "getSessionToolResult">;
type ChangeHistoryProgress = (changes: TurnFileChange[]) => void;
const STALE_HISTORY = "STALE_SESSION_ANCHOR";

function staleHistoryError() {
  return Object.assign(new Error("会话内容已更新，请重试"), { code: STALE_HISTORY });
}

export async function loadSessionChangeHistory(
  api: ChangeHistoryApi,
  sessionId: string,
  workspacePath: string | null,
  signal: AbortSignal,
  onProgress?: ChangeHistoryProgress,
): Promise<TurnFileChange[]> {
  try {
    return await readChangeHistory(api, sessionId, workspacePath, signal, onProgress);
  } catch (error) {
    signal.throwIfAborted();
    if ((error as { code?: string })?.code !== STALE_HISTORY) throw error;
    // Ordinal cursors belong to one revision. Start again from the newest page.
    return readChangeHistory(api, sessionId, workspacePath, signal, onProgress);
  }
}

async function readChangeHistory(
  api: ChangeHistoryApi,
  sessionId: string,
  workspacePath: string | null,
  signal: AbortSignal,
  onProgress?: ChangeHistoryProgress,
): Promise<TurnFileChange[]> {
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
    if (cursor && revision !== page.history?.revision) throw staleHistoryError();
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
        if (!detail || detail.history?.delivery !== "trace" || detail.history.revision !== revision) throw staleHistoryError();
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
    pages.unshift(changes);
    if (onProgress) onProgress(pages.flat());
    cursor = page.history?.nextCursor ?? undefined;
    if (!cursor && page.history?.hasMore) throw new Error("会话记录分页中断，请重试");
    if (cursor && seenCursors.has(cursor)) throw new Error("会话记录分页重复，请重试");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return pages.flat();
}
