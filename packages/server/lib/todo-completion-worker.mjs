import { Worker, isMainThread, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";

/** Keep calendar database work off both the HTTP and conversation event loops. */
export function startTodoCompletionWorker(databasePath, onError) {
  let worker;
  let restart;
  let closed = false;
  function start() {
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { kind: "todo-completion", databasePath } });
      worker.on("error", onError);
      worker.once("exit", () => {
        worker = undefined;
        if (!closed) restart = setTimeout(start, 5000).unref();
      });
      worker.unref();
    } catch (error) {
      onError(error);
      if (!closed) restart = setTimeout(start, 5000).unref();
    }
  }
  start();
  return async () => {
    closed = true;
    clearTimeout(restart);
    await worker?.terminate();
  };
}

if (!isMainThread && workerData?.kind === "todo-completion") {
  const { default: Database } = await import("better-sqlite3");
  const { SQLiteTodoUnitOfWork, TodoApplicationService, processNextTodoCompletion } = await import("@agent/core");
  const db = new Database(workerData.databasePath, { fileMustExist: true, timeout: 100 });
  const todos = new TodoApplicationService(new SQLiteTodoUnitOfWork(db));
  for (;;) {
    try {
      const processed = processNextTodoCompletion(db, todos);
      await delay(processed ? 10 : 2000);
    } catch (error) {
      if (!String(error?.code).startsWith("SQLITE_BUSY")) console.warn("Calendar completion worker retry:", error.message);
      await delay(250);
    }
  }
}
