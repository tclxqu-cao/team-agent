import { randomUUID } from "node:crypto";
import { getDatabase } from "./SQLiteDatabase.js";
import { DEFAULT_MESSAGING_SETTINGS, type ChannelMessage, type DeliveryRecord, type MessageRecord, type MessagingSettings, type MessagingWorkerStatus } from "../domain/messaging/types.js";
import type { MessagingRepository } from "../application/messaging/ports.js";

export class SQLiteMessagingRepository implements MessagingRepository {
  private db;
  constructor(baseDir: string) {
    this.db = getDatabase(baseDir).db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messaging_message (
        id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, received_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messaging_received ON messaging_message(received_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS messaging_route_status ON messaging_message(json_extract(payload,'$.routing.status'));
      CREATE INDEX IF NOT EXISTS messaging_execution_status ON messaging_message(json_extract(payload,'$.execution.status'));
      CREATE INDEX IF NOT EXISTS messaging_context ON messaging_message(json_extract(payload,'$.source.connectionId'),json_extract(payload,'$.source.conversationId'));
      CREATE TABLE IF NOT EXISTS messaging_delivery (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
        event_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messaging_delivery_message ON messaging_delivery(message_id);
      CREATE INDEX IF NOT EXISTS messaging_delivery_status ON messaging_delivery(json_extract(payload,'$.status'));
      CREATE TABLE IF NOT EXISTS messaging_state (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messaging_binding (key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messaging_lease (id TEXT PRIMARY KEY, owner TEXT NOT NULL, until_ms INTEGER NOT NULL);
    `);
  }
  state<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT payload FROM messaging_state WHERE key = ?").get(key) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : structuredClone(fallback);
  }
  setState(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO messaging_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(key, JSON.stringify(value));
  }
  settings(): MessagingSettings { return this.state("settings", DEFAULT_MESSAGING_SETTINGS); }
  saveSettings(value: MessagingSettings): void { this.setState("settings", value); }
  worker(): MessagingWorkerStatus { return this.state("worker", { state: "paused", updatedAt: new Date().toISOString() }); }
  status(value: MessagingWorkerStatus): void { this.setState("worker", value); }
  lease(owner: string, duration = 120_000): boolean {
    return this.db.prepare(`INSERT INTO messaging_lease VALUES ('worker', ?, ?) ON CONFLICT(id)
      DO UPDATE SET owner=excluded.owner, until_ms=excluded.until_ms
      WHERE messaging_lease.owner=excluded.owner OR messaging_lease.until_ms < ?`).run(owner, Date.now() + duration, Date.now()).changes === 1;
  }
  release(owner: string): void { this.db.prepare("DELETE FROM messaging_lease WHERE owner=?").run(owner); }
  insert(source: ChannelMessage): MessageRecord {
    const key = JSON.stringify([source.channel, source.connectionId, source.conversationId, source.sourceId]);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT payload FROM messaging_message WHERE source_key=?").get(key) as { payload: string } | undefined;
      if (existing) return JSON.parse(existing.payload) as MessageRecord;
      const now = new Date().toISOString();
      const accepted = source.directMention && !source.ownMessage;
      const record: MessageRecord = {
        id: randomUUID(), source, receivedAt: now, updatedAt: now, revision: 0,
        routing: { status: accepted ? "pending" : "ignored", mode: this.settings().routingMode,
          ...(!accepted ? { decision: { action: "ignore" as const, reason: source.ownMessage ? "本人发送的消息，不触发派发" : "正文没有直接提及本人" } } : {}) },
        execution: { status: "pending", lastSequence: 0 },
        timeline: [{ at: now, stage: "received", text: accepted ? "已接收正文直接 @本人的消息" : "已接收，未触发派发" }],
      };
      this.db.prepare("INSERT INTO messaging_message VALUES (?, ?, ?, 0, ?)").run(record.id, key, now, JSON.stringify(record));
      return record;
    })();
  }
  ingestBatch(messages: ChannelMessage[], cursorKey: string, cursor: unknown): void {
    this.db.transaction(() => { messages.forEach(message => this.insert(message)); this.setState(cursorKey, cursor); })();
  }
  get(id: string): MessageRecord | null {
    const row = this.db.prepare("SELECT payload FROM messaging_message WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  save(record: MessageRecord): void {
    const updated = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString(), timeline: record.timeline.slice(-100) };
    if (this.db.prepare("UPDATE messaging_message SET payload=?, revision=? WHERE id=? AND revision=?")
      .run(JSON.stringify(updated), updated.revision, record.id, record.revision).changes !== 1) throw new Error("消息已被另一执行器更新");
    Object.assign(record, updated);
  }
  commit(record: MessageRecord, deliveries: DeliveryRecord[]): void {
    this.db.transaction(() => { deliveries.forEach(item => this.addDelivery(item)); this.save(record); })();
  }
  private records(where: string, limit = 100): MessageRecord[] {
    return (this.db.prepare("SELECT payload FROM messaging_message WHERE " + where + " ORDER BY received_at, id LIMIT ?").all(limit) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  pending(): MessageRecord[] { return this.records("json_extract(payload,'$.routing.status') IN ('pending','routing')"); }
  context(source: ChannelMessage) {
    const key = JSON.stringify([source.channel, source.connectionId, source.conversationId, source.sourceId]);
    const rows = this.db.prepare(`SELECT json_extract(payload,'$.source.text') AS text,
      json_extract(payload,'$.routing.decision.projectId') AS projectId FROM messaging_message
      WHERE json_extract(payload,'$.source.connectionId')=? AND json_extract(payload,'$.source.conversationId')=?
      AND json_extract(payload,'$.source.sourceId')!=? AND json_extract(payload,'$.source.ownMessage')=0
      AND rowid < (SELECT rowid FROM messaging_message WHERE source_key=?)
      ORDER BY rowid DESC LIMIT 6`).all(source.connectionId, source.conversationId, source.sourceId, key) as Array<{ text: string; projectId: string | null }>;
    return rows.reverse().map(row => ({ text: row.text.slice(0, 2000), ...(row.projectId ? { projectId: row.projectId } : {}) }));
  }
  active(): MessageRecord[] { return this.records("json_extract(payload,'$.routing.status')='routed' AND json_extract(payload,'$.execution.status') IN ('pending','dispatching','queued','running','waiting','unknown')"); }
  list(input: { before?: string; query?: string; filter?: string } = {}) {
    const where: string[] = ["1=1"]; const values: (string | number)[] = [];
    if (input.before) {
      const parts = JSON.parse(input.before) as string[];
      if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => typeof p !== "string")) throw new Error("分页标记无效");
      where.push("(received_at < ? OR (received_at = ? AND id < ?))"); values.push(parts[0], parts[0], parts[1]);
    }
    if (input.query) { where.push("(instr(lower(json_extract(payload,'$.source.text')),lower(?))>0 OR instr(lower(json_extract(payload,'$.source.conversationName')),lower(?))>0)"); values.push(input.query, input.query); }
    if (input.filter === "review") where.push("json_extract(payload,'$.routing.status')='review'");
    if (input.filter === "mentioned") where.push("json_extract(payload,'$.source.directMention')=1 AND json_extract(payload,'$.source.ownMessage')=0");
    if (input.filter === "running") where.push("json_extract(payload,'$.execution.status') IN ('dispatching','queued','running','waiting','unknown')");
    if (input.filter === "completed") where.push("json_extract(payload,'$.execution.status')='completed'");
    if (input.filter === "deliveryFailed") where.push("EXISTS (SELECT 1 FROM messaging_delivery d WHERE d.message_id=messaging_message.id AND json_extract(d.payload,'$.status') IN ('failed','unknown','blocked'))");
    const rows = (this.db.prepare("SELECT payload FROM messaging_message WHERE " + where.join(" AND ") + " ORDER BY received_at DESC,id DESC LIMIT 51").all(...values) as { payload: string }[]).map(row => JSON.parse(row.payload) as MessageRecord);
    const messages = rows.slice(0, 50).map(record => {
      const { raw: _raw, ...source } = record.source;
      const deliveries = this.deliveries(record.id);
      const deliveryStatus = !deliveries.length ? "none" as const : deliveries.every(item => item.status === "sent") ? "sent" as const
        : (["unknown", "failed", "blocked", "sending", "pending"] as const).find(status => deliveries.some(item => item.status === status)) ?? "pending";
      return { ...record, source, deliveryStatus };
    });
    const last = messages.at(-1);
    return { messages, nextCursor: rows.length > 50 && last ? JSON.stringify([last.receivedAt, last.id]) : null, worker: this.worker(), counts: this.counts() };
  }
  private counts() {
    const count = (where = "1=1") => (this.db.prepare("SELECT count(*) AS n FROM messaging_message WHERE " + where).get() as { n: number }).n;
    return { total: count(), review: count("json_extract(payload,'$.routing.status')='review'"),
      running: count("json_extract(payload,'$.execution.status') IN ('dispatching','queued','running','waiting')"),
      completed: count("json_extract(payload,'$.execution.status')='completed'"),
      deliveryFailed: (this.db.prepare("SELECT count(*) AS n FROM messaging_delivery WHERE json_extract(payload,'$.status') IN ('failed','unknown','blocked')").get() as { n: number }).n };
  }
  binding(key: string): string | null { return (this.db.prepare("SELECT session_id FROM messaging_binding WHERE key=?").get(key) as { session_id: string } | undefined)?.session_id ?? null; }
  bind(key: string, sessionId: string): void { this.db.prepare("INSERT INTO messaging_binding VALUES (?,?) ON CONFLICT(key) DO NOTHING").run(key, sessionId); }
  addDelivery(item: DeliveryRecord): void {
    const key = JSON.stringify([item.messageId, item.eventId, item.target.kind, item.target.address]);
    this.db.prepare("INSERT OR IGNORE INTO messaging_delivery VALUES (?,?,?,?)").run(item.id, item.messageId, key, JSON.stringify(item));
  }
  deliveries(messageId?: string): DeliveryRecord[] {
    const sql = messageId ? "SELECT payload FROM messaging_delivery WHERE message_id=?"
      : "SELECT payload FROM messaging_delivery WHERE json_extract(payload,'$.status')='sending' OR (json_extract(payload,'$.status')='pending' AND json_extract(payload,'$.nextAttemptAt')<=?) ORDER BY rowid LIMIT 100";
    return (this.db.prepare(sql).all(...(messageId ? [messageId] : [Date.now()])) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  delivery(id: string): DeliveryRecord | null {
    const row = this.db.prepare("SELECT payload FROM messaging_delivery WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  saveDelivery(item: DeliveryRecord): void { item.updatedAt = new Date().toISOString(); this.db.prepare("UPDATE messaging_delivery SET payload=? WHERE id=?").run(JSON.stringify(item), item.id); }
}
