import { NextResponse } from "next/server";
import { getEngineSwitchContainer } from "../../../../../lib/engine-switch/container";
import { getNativeRuntimeService } from "../../../../../lib/native-runtime-service";
import type { Message } from "@agent/core";

/**
 * GET /api/sessions/[id]/thread-history
 *
 * Merged, chronological history of the logical thread a session belongs to:
 * every member session's messages in switch order, with a marker message at
 * each engine boundary. Display-only — nothing is written into any engine's
 * native transcript.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const container = getEngineSwitchContainer();
    const native = getNativeRuntimeService();
    const { thread, records } = container.ledger.ledger(params.id);
    if (!thread || records.length === 0) {
      return NextResponse.json({ threadKey: null, activeSessionId: params.id, messages: [], segments: [] });
    }

    // Member sessions in first-seen order.
    const order: string[] = [];
    for (const record of records) {
      for (const sessionId of [record.fromSessionId, record.toSessionId]) {
        if (!order.includes(sessionId)) order.push(sessionId);
      }
    }

    // Walk the switch ledger chronologically. Each record contributes the
    // source session's messages produced during that phase (tracked with a
    // per-session consumed cursor), followed by a switch marker.
    const consumed = new Map<string, number>();
    const messages: Array<Record<string, unknown> | Message> = [];
    const segments: Array<{ sessionId: string; agentType: string; title: string; messageCount: number }> = [];

    // Collect non-empty phases first; markers are inserted only between
    // segments that actually carry messages (no empty-switch noise).
    const phases: Array<{ agentType: string; messages: Message[] }> = [];

    for (const record of records) {
      const from = record.fromSessionId;
      try {
        const detail = await native.get(from);
        const start = consumed.get(from) ?? 0;
        const rest = detail.messages.slice(start);
        consumed.set(from, detail.messages.length);
        if (rest.length) phases.push({ agentType: detail.agentType, messages: rest });
      } catch { /* source session deleted upstream — skip its phase */ }
    }

    // The active session's current phase comes last.
    const active = thread.currentSessionId;
    try {
      const detail = await native.get(active);
      const start = consumed.get(active) ?? 0;
      const rest = detail.messages.slice(start);
      consumed.set(active, detail.messages.length);
      if (rest.length) phases.push({ agentType: detail.agentType, messages: rest });
    } catch { /* active session unavailable */ }

    phases.forEach((phase, index) => {
      if (index > 0) {
        messages.push({
          role: "assistant",
          content: `⟲ 已切换引擎 → ${phase.agentType}（以下为该引擎的会话记录）`,
          historyId: `thread-switch-${index}`,
          name: "__thread_switch__",
        });
      }
      messages.push(...phase.messages);
      segments.push({
        sessionId: index === phases.length - 1 ? active : records[index]?.fromSessionId ?? active,
        agentType: phase.agentType,
        title: "",
        messageCount: phase.messages.length,
      });
    });

    return NextResponse.json({
      threadKey: thread.threadKey,
      activeSessionId: active,
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
