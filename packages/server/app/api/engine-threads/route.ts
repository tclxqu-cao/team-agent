import { NextResponse } from "next/server";
import { getEngineSwitchContainer } from "../../../lib/engine-switch/container";
import { getNativeRuntimeService } from "../../../lib/native-runtime-service";

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
      const members: Array<{ id: string; agentType?: string; title?: string; status?: string; cwd?: string }> = [];
      for (const sessionId of memberIds) {
        try {
          const detail = await native.get(sessionId);
          const summary = { agentType: detail.agentType, title: detail.title, status: detail.status, cwd: detail.cwd };
          members.push({ id: sessionId, agentType: summary.agentType, title: summary.title, status: summary.status, cwd: summary.cwd });
        } catch {
          members.push({ id: sessionId });
        }
      }
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
