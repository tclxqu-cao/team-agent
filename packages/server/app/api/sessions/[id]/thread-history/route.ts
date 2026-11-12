import { NextResponse } from "next/server";
import { getEngineSwitchContainer } from "../../../../../lib/engine-switch/container";
import { getNativeRuntimeService } from "../../../../../lib/native-runtime-service";
import type { Message } from "@agent/core";

/**
 * GET /api/sessions/[id]/thread-history?limit=120
 *
 * Merged, chronological view of the logical thread a session belongs to.
 * Each member session contributes only the tail of its transcript (paged
 * read, not a full pull) so the view opens fast; earlier messages are
 * summarized by a placeholder (full history stays in the native session).
 * Switch markers are inserted between phases. Display-only — nothing is
 * written into any engine's native transcript.
 */

const DEFAULT_PHASE_LIMIT = 120;
const MAX_PHASE_LIMIT = 400;

/** How the merged view hands messages back: tail of each phase, deduped. */
interface ThreadPhase {
  agentType: string;
  sessionId: string;
  messages: Message[];
  /** Messages omitted from the head of this phase by the tail limit. */
  omitted: number;
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit"));
    const phaseLimit = Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_PHASE_LIMIT)
      : DEFAULT_PHASE_LIMIT;

    const container = getEngineSwitchContainer();
    const native = getNativeRuntimeService();
    const { thread, records } = container.ledger.ledger(params.id);
    if (!thread || records.length === 0) {
      return NextResponse.json({ threadKey: null, activeSessionId: params.id, messages: [], segments: [] });
    }

    // Chronological walk of the switch ledger. Each phase reads only the tail
    // of its source session (paged get) and dedupes against everything already
    // shown, so reused source sessions contribute just their increment.
    const seen = new Set<string>();
    const phases: ThreadPhase[] = [];

    const collectPhase = async (sessionId: string, isLast: boolean): Promise<void> => {
      try {
        const detail = await native.get(sessionId, { limit: phaseLimit * 2, view: "core" });
        const all = detail.messages ?? [];
        // Newest-first: keep until we hit an already-shown message. Keys are
        // session-scoped (historyIds like "seq-0" collide across sessions).
        const keyOf = (index: number): string => {
          const message = all[index];
          return `${sessionId}:${message.historyId ?? index}`;
        };
        const fresh: Message[] = [];
        for (let index = all.length - 1; index >= 0; index--) {
          if (seen.has(keyOf(index))) break;
          fresh.unshift(all[index]);
        }
        for (let index = all.length - fresh.length; index < all.length; index++) {
          seen.add(keyOf(index));
        }
        if (fresh.length === 0 && !isLast) return; // nothing new from this phase
        const omitted = Math.max(0, fresh.length - phaseLimit);
        const tail = fresh.slice(Math.max(0, fresh.length - phaseLimit));
        phases.push({
          agentType: detail.agentType,
          sessionId,
          messages: tail,
          omitted,
        });
      } catch { /* member session unavailable — skip its phase */ }
    };

    for (const record of records) {
      await collectPhase(record.fromSessionId, false);
    }
    // The active session's current phase comes last.
    await collectPhase(thread.currentSessionId, true);

    // Drop leading empty phases so the view starts with real content.
    const nonEmpty = phases.filter((phase) => phase.messages.length > 0 || phase.omitted > 0);

    const messages: Array<Record<string, unknown> | Message> = [];
    const segments: Array<{ sessionId: string; agentType: string; messageCount: number; omitted: number }> = [];
    nonEmpty.forEach((phase, index) => {
      if (index > 0) {
        messages.push({
          role: "assistant",
          content: `⟲ 已切换引擎 → ${phase.agentType}（以下为该引擎的会话记录）`,
          historyId: `thread-switch-${index}`,
          name: "__thread_switch__",
        });
      }
      if (phase.omitted > 0) {
        messages.push({
          role: "assistant",
          content: `…此处省略更早的 ${phase.omitted} 条消息（完整记录见该引擎原始会话）`,
          historyId: `thread-phase-head-${index}`,
          name: "__thread_switch__",
        });
      }
      messages.push(...phase.messages);
      segments.push({
        sessionId: phase.sessionId,
        agentType: phase.agentType,
        messageCount: phase.messages.length,
        omitted: phase.omitted,
      });
    });

    return NextResponse.json({
      threadKey: thread.threadKey,
      activeSessionId: thread.currentSessionId,
      truncated: phases.some((phase) => phase.omitted > 0),
      messages,
      segments,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read thread history" },
      { status: 500 },
    );
  }
}
