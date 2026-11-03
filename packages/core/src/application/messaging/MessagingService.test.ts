import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMessagingRepository } from "../../infrastructure/SQLiteMessagingRepository.js";
import { getDatabase } from "../../infrastructure/SQLiteDatabase.js";
import { DEFAULT_MESSAGING_SETTINGS } from "../../domain/messaging/types.js";
import type { MessagingRuntime, ExecutionObservation } from "./ports.js";
import { MessagingService } from "./MessagingService.js";
import { candidateFixture, messageFixture } from "./fixtures.js";

const paths: string[] = [];
afterEach(() => { paths.splice(0).forEach(path => { getDatabase(path).close(); rmSync(path, { recursive: true, force: true }); }); });
function setup() {
  const path = mkdtempSync(join(tmpdir(), "messaging-service-")); paths.push(path);
  const repository = new SQLiteMessagingRepository(path);
  repository.saveSettings({ ...structuredClone(DEFAULT_MESSAGING_SETTINGS), enabled: true });
  const runtime = {
    candidates: vi.fn(async () => candidateFixture),
    route: vi.fn<MessagingRuntime["route"]>(async () => ({ action: "dispatch", projectId: "refund", agentType: "codex", reason: "消息明确提到 refund", model: "fixture/router" })),
    createSession: vi.fn(async () => "runtime:codex:source"),
    dispatch: vi.fn(async () => ({ queueItemId: "item-1", runId: "run-1" })),
    observe: vi.fn(async (): Promise<ExecutionObservation> => ({ status: "running", events: [] })),
    send: vi.fn<MessagingRuntime["send"]>(async () => ({ status: "sent", receipt: "fixture-receipt" })),
  } satisfies MessagingRuntime;
  return { path, repository, runtime, service: new MessagingService(repository, runtime) };
}
it("deduplicates receipt, persists routing evidence, and separates completed execution from uncertain delivery", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture());
  expect(service.receive(messageFixture()).id).toBe(record.id);
  await service.routePending(); await service.executePending();
  runtime.observe.mockResolvedValue({ status: "completed", sequence: 3, runId: "run-1", events: [{ id: "run-1:3", sequence: 3, kind: "completed", text: "已确认根因" }] });
  await service.executePending();
  expect(repository.get(record.id)?.execution.result).toBe("已确认根因");
  expect(repository.get(record.id)?.routing.decision?.model).toBe("fixture/router");
  runtime.send.mockRejectedValueOnce(new Error("ack lost"));
  await service.deliver(); await service.deliver();
  expect(repository.get(record.id)?.execution.status).toBe("completed");
  expect(repository.deliveries(record.id)[0].status).toBe("unknown");
  expect(runtime.send).toHaveBeenCalledTimes(1);
  expect(runtime.dispatch).toHaveBeenCalledTimes(1);
  service.receive(messageFixture()); await service.routePending(); await service.executePending();
  expect(runtime.route).toHaveBeenCalledTimes(1);
});
it("keeps untrusted model targets in review and allows a validated manual decision", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture());
  runtime.route.mockResolvedValueOnce({ action: "dispatch", projectId: "not-registered", agentType: "codex", reason: "injected", model: "fixture" });
  await service.routePending(); await service.executePending();
  expect(repository.get(record.id)?.routing.status).toBe("review");
  expect(runtime.dispatch).not.toHaveBeenCalled();
  await expect(service.resolve(record.id, { action: "dispatch", projectId: "outside", agentType: "codex", reason: "manual" })).rejects.toThrow("候选列表");
  await service.resolve(record.id, { action: "dispatch", projectId: "refund", agentType: "codex", reason: "manual" });
  expect(repository.get(record.id)?.routing.confirmedByUser).toBe(true);
  expect(repository.get(record.id)?.routing.initialDecision?.reason).toContain("候选列表");
  await service.executePending(); expect(runtime.dispatch).toHaveBeenCalledTimes(1);
});
it("uses simple rules without calling the model and excludes own/non-mention messages", async () => {
  const { repository, service, runtime } = setup();
  repository.saveSettings({ ...repository.settings(), routingMode: "rules", rules: [{ conversationId: "group-1", projectId: "refund", agentType: "codex" }] });
  service.receive(messageFixture({ sourceId: "own", ownMessage: true }));
  service.receive(messageFixture({ sourceId: "plain", directMention: false }));
  const record = service.receive(messageFixture());
  await service.routePending();
  expect(runtime.route).not.toHaveBeenCalled();
  expect(repository.get(record.id)?.routing.status).toBe("routed");
  expect(repository.list().counts.total).toBe(3);
});
it("reconciles a persisted dispatch intent after restart without dispatching again", async () => {
  const { repository, service, runtime, path } = setup();
  const record = service.receive(messageFixture()); await service.routePending();
  const intent = repository.get(record.id)!;
  intent.execution = { ...intent.execution, status: "dispatching", sessionId: "runtime:codex:source" };
  repository.save(intent);
  runtime.observe.mockResolvedValue({ status: "completed", queueItemId: "item-1", runId: "run-1", sequence: 1, events: [{ id: "run-1:1", sequence: 1, kind: "completed", text: "已完成" }] });
  const restarted = new MessagingService(new SQLiteMessagingRepository(path), runtime);
  await restarted.executePending();
  expect(runtime.dispatch).not.toHaveBeenCalled();
  expect(repository.get(record.id)?.execution.status).toBe("completed");
  expect(repository.deliveries(record.id)).toHaveLength(1);
});
it("continues observing an in-flight session while collection is paused", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture()); await service.routePending(); await service.executePending();
  repository.saveSettings({ ...repository.settings(), enabled: false });
  runtime.observe.mockResolvedValue({ status: "completed", sequence: 2, events: [{ id: "run:2", sequence: 2, kind: "completed", text: "ok" }] });
  await service.executePending(); await service.deliver();
  expect(repository.get(record.id)?.execution.status).toBe("completed");
  expect(repository.deliveries(record.id)[0].status).toBe("sent");
});
it("retries a blocked delivery independently without rerunning the Agent", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture()); await service.routePending();
  runtime.observe.mockResolvedValue({ status: "completed", sequence: 1, events: [{ id: "run:1", sequence: 1, kind: "completed", text: "done" }] });
  await service.executePending();
  runtime.send.mockResolvedValueOnce({ status: "blocked", receipt: "not-sent" });
  await service.deliver();
  const delivery = repository.deliveries(record.id)[0]; service.retryDelivery(delivery.id); await service.deliver();
  expect(repository.deliveries(record.id)[0]).toMatchObject({ status: "sent", attempts: 2 });
  expect(runtime.dispatch).toHaveBeenCalledTimes(1);
});
it("returns an inspectable failure when the target cannot be prepared before dispatch", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture()); await service.routePending();
  runtime.createSession.mockRejectedValueOnce(new Error("readonly policy unavailable"));
  await service.executePending();
  expect(repository.get(record.id)?.execution.status).toBe("failed");
  expect(repository.deliveries(record.id)[0].event).toBe("failed");
  expect(runtime.dispatch).not.toHaveBeenCalled();
});
it("keeps a mention without decoded task text in review without calling the model", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture({ text: "" }));
  await service.routePending();
  expect(repository.get(record.id)?.routing.status).toBe("review");
  expect(runtime.route).not.toHaveBeenCalled();
  expect(repository.deliveries(record.id)[0].event).toBe("waiting");
});
