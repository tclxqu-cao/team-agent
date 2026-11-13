import type { EngineSwitchRecord, Message } from "@agent/core";
import { getDatabase } from "@agent/core";
import { resolveNativeRuntimeDirectory } from "@agent/native-runtime";

export const frozenTurnId = (recordId: string, ordinal: number) => `engine-frozen:${encodeURIComponent(recordId)}:${ordinal}`;
export interface FrozenPhaseInfo { count: number; boundaryUncertain: boolean }

/** Derived, rebuildable index. Large immutable snapshots are parsed once, never per page. */
export class EngineHistoryStore {
  constructor(private readonly db: ReturnType<typeof getDatabase>["db"]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_history_phase_v1 (
        record_id TEXT PRIMARY KEY, count INTEGER NOT NULL, uncertain INTEGER NOT NULL, raw_json TEXT
      );
      CREATE TABLE IF NOT EXISTS engine_history_item_v1 (
        record_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL,
        history_id TEXT NOT NULL, payload TEXT NOT NULL, preview TEXT,
        PRIMARY KEY (record_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS engine_history_trace_v1 (
        record_id TEXT NOT NULL, turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (record_id, turn_id, ordinal)
      );
    `);
  }

  info(recordId: string): FrozenPhaseInfo | null {
    const row = this.db.prepare("SELECT count, uncertain FROM engine_history_phase_v1 WHERE record_id=?").get(recordId) as { count: number; uncertain: number } | undefined;
    return row ? { count: row.count, boundaryUncertain: !!row.uncertain } : null;
  }

  raw(recordId: string, snapshotOnly = false): Pick<EngineSwitchRecord, "sourceSnapshot" | "phaseMessages"> {
    const row = this.db.prepare(`SELECT CASE WHEN phase_messages IS NULL OR ? THEN source_snapshot END AS source_snapshot,
      CASE WHEN ? THEN NULL ELSE phase_messages END AS phase_messages FROM engine_switch_records WHERE id=?`)
      .get(Number(snapshotOnly), Number(snapshotOnly), recordId) as { source_snapshot: string | null; phase_messages: string | null } | undefined;
    return { sourceSnapshot: row?.source_snapshot ? JSON.parse(row.source_snapshot) : undefined,
      phaseMessages: row?.phase_messages ? JSON.parse(row.phase_messages) : undefined };
  }

  install(record: EngineSwitchRecord, messages: Message[], uncertain: boolean, keepRaw: boolean): FrozenPhaseInfo {
    const core: Message[][] = [];
    const traces = new Map<string, Message[]>();
    const results = new Map(messages.filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => [message.toolCallId!, message]));
    let turnId = frozenTurnId(record.id, 0);
    let hasUser = false;
    const lazyResult = (message: Message): Message => ({ ...message, content: "", toolResultRef: {
      turnId, itemId: message.toolCallId!, revision: record.id,
      byteSize: Buffer.byteLength(message.content, "utf8"), isError: message.isError,
    } });
    for (const original of messages) {
      if (original.role !== "user" && original.role !== "assistant") continue;
      if (original.role === "user") { turnId = frozenTurnId(record.id, core.length); hasUser = true; }
      const execution = hasUser && record.fromAgentType === "codex" && original.role === "assistant" && !!(
        original.toolCalls?.length || original.presentation?.reasoning?.length || original.presentation?.agentMessagePhase === "commentary"
      );
      let message: Message = { ...original };
      if (execution || (record.fromAgentType === "codex" && original.role === "user")) {
        message.presentation = { ...message.presentation, executionTrace: { turnId, segmentIndex: 0 } };
      }
      if (message.toolCalls) message.toolCalls = message.toolCalls.map((call) => ({ ...call,
        arguments: boundedArguments(call.arguments),
      }));
      if (message.presentation?.reasoning) message.presentation = { ...message.presentation,
        reasoning: message.presentation.reasoning.map((section) => ({ ...section, text: boundedText(section.text, 4096) })),
      };
      const group = [message, ...(message.toolCalls ?? []).flatMap((call) => {
        const result = results.get(call.id);
        return result ? [lazyResult(result)] : [];
      })];
      if (execution) {
        const trace = traces.get(turnId) ?? [];
        trace.push(...group);
        traces.set(turnId, trace);
      }
      else core.push(group);
    }
    this.db.transaction(() => {
      if (this.info(record.id)) return;
      const insertItem = this.db.prepare("INSERT INTO engine_history_item_v1 (record_id, ordinal, role, history_id, payload, preview) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [ordinal, group] of core.entries()) {
        const message = group[0];
        const preview = message.role === "user" && message.name !== "__interrupt__" && message.name !== "__compaction_checkpoint__"
          ? message.content.replace(/\s+/g, " ").trim().slice(0, 120) || (message.images?.length || message.presentation?.attachments?.length ? "图片消息" : null)
          : null;
        insertItem.run(record.id, ordinal, message.role, message.historyId!, JSON.stringify(group), preview);
      }
      const insertTrace = this.db.prepare("INSERT INTO engine_history_trace_v1 (record_id, turn_id, ordinal, payload) VALUES (?, ?, ?, ?)");
      for (const [id, trace] of traces) for (const [ordinal, message] of trace.entries()) insertTrace.run(record.id, id, ordinal, JSON.stringify(message));
      this.db.prepare("INSERT INTO engine_history_phase_v1 (record_id, count, uncertain, raw_json) VALUES (?, ?, ?, ?)")
        .run(record.id, core.length, Number(uncertain), keepRaw ? JSON.stringify(messages) : null);
    })();
    return this.info(record.id)!;
  }

  page(recordId: string, start: number, end: number): Message[] {
    return (this.db.prepare("SELECT payload FROM engine_history_item_v1 WHERE record_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal")
      .all(recordId, start, end) as Array<{ payload: string }>).flatMap((row) => JSON.parse(row.payload));
  }

  boundaryStart(recordId: string, nominal: number): number {
    const row = this.db.prepare("SELECT ordinal FROM engine_history_item_v1 WHERE record_id=? AND ordinal<=? AND role='user' ORDER BY ordinal DESC LIMIT 1")
      .get(recordId, nominal) as { ordinal: number } | undefined;
    return row?.ordinal ?? 0;
  }

  boundaryEnd(recordId: string, nominal: number, total: number): number {
    const row = this.db.prepare("SELECT ordinal FROM engine_history_item_v1 WHERE record_id=? AND ordinal>=? AND role='user' ORDER BY ordinal LIMIT 1")
      .get(recordId, nominal) as { ordinal: number } | undefined;
    return row?.ordinal ?? total;
  }

  queries(recordId: string): Array<{ ordinal: number; history_id: string; preview: string }> {
    return this.db.prepare("SELECT ordinal, history_id, preview FROM engine_history_item_v1 WHERE record_id=? AND preview IS NOT NULL ORDER BY ordinal")
      .all(recordId) as Array<{ ordinal: number; history_id: string; preview: string }>;
  }

  trace(recordId: string, turnId: string): Message[] {
    return (this.db.prepare("SELECT payload FROM engine_history_trace_v1 WHERE record_id=? AND turn_id=? ORDER BY ordinal")
      .all(recordId, turnId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));
  }

  /** Full payload reads occur only when a user expands one item/result. */
  item(recordId: string, id: string, tool = false): Message | null {
    const row = this.db.prepare(`SELECT item.value AS payload FROM engine_switch_records r
      JOIN engine_history_phase_v1 p ON p.record_id=r.id,
      json_each(COALESCE(p.raw_json, r.phase_messages, '[]')) item
      WHERE r.id=? AND json_extract(item.value, ?) = ? LIMIT 1`)
      .get(recordId, tool ? "$.toolCallId" : "$.historyId", id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
}

function boundedText(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let text = "", bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > limit - 3) break;
    text += character;
  }
  return `${text}...`;
}
function boundedArguments(args: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(args);
  return Buffer.byteLength(serialized, "utf8") <= 2048 ? args : { __truncated: true, preview: boundedText(serialized, 2000) };
}
let store: EngineHistoryStore | undefined;
export function getEngineHistoryStore(): EngineHistoryStore {
  return store ??= new EngineHistoryStore(getDatabase(resolveNativeRuntimeDirectory()).db);
}
