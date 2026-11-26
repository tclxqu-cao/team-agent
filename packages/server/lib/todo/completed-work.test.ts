import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteDatabase, SQLiteTodoUnitOfWork, TodoApplicationService, processNextTodoCompletion, type AgentEvent } from "@agent/core";
import { RuntimeNotificationOutbox } from "../../../native-runtime/src/agent-runtime/runtime-notification-outbox";
import { TodoServiceClient } from "../../../native-runtime/src/todo-mcp/todo-service-client";
import { POST } from "../../app/api/internal/todo-mcp/route";
import { commitCustomerNotification } from "../notifications/customer-notifications";

const ownerId = "test-owner";
let todos: TodoApplicationService;
let sessionId: string;
let database: SQLiteDatabase;
vi.mock("./todo-mcp-credentials", () => ({
  authenticateTodoCredential: () => ({ scope: "relay", ownerId, sessionId }),
  todoServiceId: () => "test-service",
}));
vi.mock("./todo-service", () => ({
  todoServices: () => ({ db: database.db, todos, notifications: { resolveApproval() {}, ingest() {} } }),
}));
vi.mock("../web-auth/anonymous", () => ({ anonymousPrincipal: () => ({ userId: ownerId }) }));

describe("calendar completion through shared run settlement", () => {
  let root: string, outbox: RuntimeNotificationOutbox;
  let taskId: string, startedAt: number;
  const runId = "run";
  const done: AgentEvent = { type: "done", finalText: "浏览器客户端使用 WebRTC。", result: { runId, status: "completed", reason: "completed", durationMs: 500 } };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "calendar-run-"));
    database = new SQLiteDatabase(root);
    todos = new TodoApplicationService(new SQLiteTodoUnitOfWork(database.db));
    taskId = todos.execute({ type: "create", title: "cross desk 调研" }, { ownerId, requestId: "create", sourceSessionRef: "other-engine" }).task.id;
    startedAt = Date.now() + 1;
    outbox = new RuntimeNotificationOutbox(database.db);
    database.db.exec("CREATE TABLE native_runtime_event(run_id TEXT, sequence INTEGER, payload TEXT)");
  });
  afterEach(() => { vi.restoreAllMocks(); outbox.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  it.each(["codex", "zcode", "claude-code", "qoder", "workbuddy", "opencode", "deepseek-harness", "copilot", "grok", "agy"])(
    "settles the durable completion from %s without a model tool call", async engine => {
      sessionId = `runtime:${engine}:fixture`;
      const destination = () => ({ serviceId: "test-service", ownerId, descriptorPath: "fixture", relayPath: "fixture" });
      const input = engine === "zcode" ? "继续" : "CrossDesk 调研已经完成。结论是浏览器端使用 WebRTC。";
      if (engine === "zcode") {
        outbox.append(sessionId, runId, 1, { type: "todo_update", todos: [{ id: "p", title: "CrossDesk 调研", status: "completed" }] },
          startedAt, destination);
      }
      outbox.append(sessionId, runId, 2, done, startedAt + 500, destination, { input, createdAt: startedAt });
      let delivered: unknown;
      vi.spyOn(TodoServiceClient.prototype, "call").mockImplementation(async (_operation, args) => {
        delivered = args;
        // A lost acknowledgement must leave the native job available for another flush.
        if (deliveryAttempts++ === 0) throw new Error("disconnected");
        return {};
      });
      let deliveryAttempts = 0;
      await outbox.flush();
      outbox.close();
      outbox = new RuntimeNotificationOutbox(database.db);
      await outbox.flush();
      expect(deliveryAttempts).toBe(2);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await POST(new Request("http://localhost/api/internal/todo-mcp", {
          method: "POST", headers: { "x-agentroam-service-id": "test-service" },
          body: JSON.stringify({ operation: "runtime_event", args: delivered }),
        }));
        expect(response.status).toBe(200);
      }
      expect(todos.get(taskId, ownerId).task.status).toBe("pending");
      expect(processNextTodoCompletion(database.db, todos)).toBe(true);
      expect(processNextTodoCompletion(database.db, todos)).toBe(false);
      expect(todos.get(taskId, ownerId).task).toMatchObject({ status: "completed", version: 2 });
    },
  );

  it("recovers a queued report from an older broker after a failed write and a database restart", async () => {
    sessionId = "runtime:old-broker";
    const response = await POST(new Request("http://localhost/api/internal/todo-mcp", {
      method: "POST", headers: { "x-agentroam-service-id": "test-service" },
      body: JSON.stringify({ operation: "runtime_event", args: { runId, createdAt: startedAt + 500, event: done,
        completedWork: { startedAt, titles: ["CrossDesk 调研"] } } }),
    }));
    expect(response.status).toBe(200);
    database.db.exec("CREATE TRIGGER pause_test_write BEFORE UPDATE ON todo_tasks BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
    expect(() => processNextTodoCompletion(database.db, todos, startedAt)).toThrow("simulated failure");
    expect(processNextTodoCompletion(database.db, todos, startedAt)).toBe(false);
    database.db.exec("DROP TRIGGER pause_test_write");
    outbox.close();
    database.close();
    database = new SQLiteDatabase(root);
    todos = new TodoApplicationService(new SQLiteTodoUnitOfWork(database.db));
    expect(todos.get(taskId, ownerId).task.status).toBe("pending");
    expect(processNextTodoCompletion(database.db, todos, startedAt + 5000)).toBe(true);
    expect(todos.get(taskId, ownerId).task.status).toBe("completed");
  });

  it("keeps execution-scoped and failed runs out of ordinary calendar reconciliation", () => {
    const dest = { serviceId: "fixture", ownerId, descriptorPath: "fixture", relayPath: "fixture" };
    const run = { input: "CrossDesk 调研已完成", createdAt: startedAt };
    outbox.append("session", runId, 1, done, startedAt, () => ({ ...dest, executionId: "scheduled-run" }), run);
    outbox.append("session", runId, 2, { type: "error", message: "failed" }, startedAt, () => dest, run);
    const rows = database.db.prepare("SELECT payload FROM native_runtime_notification_outbox").all() as { payload: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(JSON.parse(row.payload)).not.toHaveProperty("completionSource");
  });

  it("uses the built-in agent's current plan and ignores a previous turn's completed plan", () => {
    sessionId = randomUUID();
    const db = database.db;
    db.prepare("INSERT INTO projects(id,name,created,updated) VALUES ('p','p','','')").run();
    db.prepare("INSERT INTO sessions(id,project_id,created,updated,metadata) VALUES (?,'p','','',?)")
      .run(sessionId, JSON.stringify({ customerAgentActiveRun: { runId, messageStart: 0, eventStart: 1, startedAt: new Date(startedAt).toISOString() } }));
    db.prepare("INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,'user','继续',?)").run(sessionId, startedAt);
    const writePlan = () => db.prepare("INSERT INTO events(session_id,type,data,timestamp) VALUES (?,'todo_update',?,?)")
      .run(sessionId, JSON.stringify({ todos: [{ id: "plan-1", title: "CrossDesk 调研", status: "completed" }] }), startedAt);
    const persistDone = () => {
      const inserted = db.prepare("INSERT INTO events(session_id,type,data,timestamp) VALUES (?,'done',?,?)").run(sessionId, JSON.stringify(done), startedAt + 500);
      commitCustomerNotification(db, sessionId, done, startedAt + 500, Number(inserted.lastInsertRowid));
    };
    writePlan();
    persistDone();
    writePlan(); // A subsequent turn can finish before the queued job is processed.
    expect(processNextTodoCompletion(db, todos)).toBe(true);
    expect(todos.get(taskId, ownerId).task.status).toBe("pending");
    persistDone();
    expect(todos.get(taskId, ownerId).task.status).toBe("pending");
    expect(processNextTodoCompletion(db, todos)).toBe(true);
    expect(todos.get(taskId, ownerId).task.status).toBe("completed");
  });
});
