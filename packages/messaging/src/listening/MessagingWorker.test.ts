import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase } from "@agent/core";
import { SQLiteMessagingRepository } from "../infrastructure/SQLiteMessagingRepository";
import { DEFAULT_MESSAGING_SETTINGS } from "../domain/types";
import { messageFixture } from "../testing/fixtures";
import { MessagingWorker } from "./MessagingWorker";

const fixtures: Array<{ path: string; workers: MessagingWorker[] }> = [];
const runs: Promise<void>[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const fixture of fixtures) for (const worker of fixture.workers) worker.close();
  releases.splice(0).forEach(release => release());
  await Promise.allSettled(runs.splice(0));
  for (const { path } of fixtures.splice(0)) { getDatabase(path).close(); rmSync(path, { recursive: true, force: true }); }
  vi.useRealTimers();
});
function deferred() {
  let finish!: () => void;
  const promise = new Promise<void>(resolve => { finish = resolve; });
  releases.push(finish);
  return { promise, finish };
}
function setup() {
  const path = mkdtempSync(join(tmpdir(), "messaging-worker-"));
  const repository = new SQLiteMessagingRepository(path);
  repository.saveSettings({ ...structuredClone(DEFAULT_MESSAGING_SETTINGS), enabled: true });
  const service = { routePending: vi.fn(async () => {}), executePending: vi.fn(async () => {}), deliver: vi.fn(async () => {}) };
  const intake = { collect: vi.fn(async () => {}) };
  const fixture = { path, workers: [] as MessagingWorker[] }; fixtures.push(fixture);
  const worker = () => { const value = new MessagingWorker(repository, service, intake, { autoStart: false }); fixture.workers.push(value); return value; };
  const tick = (value: MessagingWorker) => { const run = value.tick(); runs.push(run); return run; };
  return { repository, service, intake, worker, tick };
}
it("continues collection, execution observation and delivery while project routing is slow", async () => {
  const { repository, service, intake, worker, tick } = setup();
  const route = deferred(); service.routePending.mockReturnValue(route.promise);
  const listener = worker(); const first = tick(listener);
  await Promise.resolve(); await Promise.resolve();
  await tick(listener);
  expect(service.routePending).toHaveBeenCalledTimes(1);
  expect(intake.collect).toHaveBeenCalledTimes(2);
  expect(service.executePending).toHaveBeenCalledTimes(2);
  expect(service.deliver).toHaveBeenCalledTimes(2);
  expect(repository.worker().stages?.route.state).toBe("running");
  route.finish(); await first;
  expect(repository.worker().stages?.route.state).toBe("idle");
});
it("keeps collection singular while allowing the other stages to progress", async () => {
  const { service, intake, worker, tick } = setup();
  const read = deferred(); intake.collect.mockReturnValue(read.promise);
  const listener = worker(); const first = tick(listener);
  await Promise.resolve(); await Promise.resolve();
  await tick(listener);
  expect(intake.collect).toHaveBeenCalledTimes(1);
  expect(service.routePending).toHaveBeenCalledTimes(2);
  expect(service.deliver).toHaveBeenCalledTimes(2);
  read.finish(); await first;
});
it("holds and renews the cross-process lease until in-flight work drains after close", async () => {
  vi.useFakeTimers();
  const { repository, service, worker, tick } = setup();
  const route = deferred(); service.routePending.mockReturnValue(route.promise);
  const first = worker(); const run = tick(first);
  await Promise.resolve(); await Promise.resolve();
  first.close();
  await vi.advanceTimersByTimeAsync(125_000);
  expect(repository.lease("competing-process")).toBe(false);
  const second = worker(); await tick(second);
  expect(service.routePending).toHaveBeenCalledTimes(1);
  route.finish(); await run;
  expect(repository.lease("competing-process")).toBe(true);
  repository.release("competing-process");
});
it("isolates source failures and retains ownership while scheduling subsequent stages", async () => {
  const { repository, service, intake, worker, tick } = setup();
  intake.collect.mockImplementation(() => { throw new Error("reader failed"); });
  const competing: boolean[] = [];
  service.executePending.mockImplementation(async () => { competing.push(repository.lease("competing-process")); });
  await tick(worker());
  expect(competing).toEqual([false]);
  expect(service.routePending).toHaveBeenCalledTimes(1);
  expect(service.deliver).toHaveBeenCalledTimes(1);
  expect(repository.worker().stages?.collect).toMatchObject({ state: "error", error: "reader failed" });
});
it("observes and delivers in-flight work when listening is paused", async () => {
  const { repository, service, intake, worker, tick } = setup();
  const record = repository.insert(messageFixture());
  record.routing.status = "routed"; record.execution.status = "running"; repository.save(record);
  repository.saveSettings({ ...repository.settings(), enabled: false });
  await tick(worker());
  expect(intake.collect).not.toHaveBeenCalled();
  expect(service.routePending).not.toHaveBeenCalled();
  expect(service.executePending).toHaveBeenCalledTimes(1);
  expect(service.deliver).toHaveBeenCalledTimes(1);
});
