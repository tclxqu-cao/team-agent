import { NextResponse } from "next/server";
import { getEngineSwitchContainer } from "../../../lib/engine-switch/container";
import { getNativeRuntimeService } from "../../../lib/native-runtime-service";
import type { EngineThreadSessionSummary } from "@agent/native-runtime";

/**
 * GET /api/engine-threads
 *
 * Lists every logical engine thread with its member sessions, so the sidebar
 * can fold switch-generated engine sessions under one parent conversation
 * (T3-style: one AppThread visible, provider sessions are refs).
 */
export async function GET() {
  try {
    const { ledger } = getEngineSwitchContainer();
    const native = getNativeRuntimeService();
    const threads = await ledger.listThreads();
    const result = [];
    for (const thread of threads) {
      const records = ledger.recordsFor(thread.threadKey);
      const memberIds: string[] = [];
      for (const record of records) {
        for (const sessionId of [record.fromSessionId, record.toSessionId]) {
          if (!memberIds.includes(sessionId)) memberIds.push(sessionId);
        }
      }
      const members = await Promise.all(memberIds.map(async (sessionId): Promise<Partial<EngineThreadSessionSummary> & { id: string }> => {
        try {
          const summary = await native.getSummary?.(sessionId);
          if (!summary) throw new Error("Runtime session summaries are unavailable");
          return summary as EngineThreadSessionSummary;
        } catch {
          return { id: sessionId };
        }
      }));
      // Title anchors on the thread's origin session (the first source), so the
      // sidebar shows a human name instead of internal thread keys.
      const originId = records[0]?.fromSessionId;
      const origin = members.find((member) => member.id === originId);
      result.push({
        threadKey: thread.threadKey,
        title: origin?.title || thread.currentAgentType,
        originSessionId: originId ?? thread.currentSessionId,
        currentSessionId: thread.currentSessionId,
        currentAgentType: thread.currentAgentType,
        created: thread.created,
        updated: thread.updated,
        members,
      });
    }
    return NextResponse.json({ threads: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list engine threads" },
      { status: 500 },
    );
  }
}
