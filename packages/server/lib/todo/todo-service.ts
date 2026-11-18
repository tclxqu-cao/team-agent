import { getDatabase, SQLiteTodoUnitOfWork, TodoApplicationService, TodoScheduler, TodoExecutionService, PersistentNotificationService } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";
export function createTodoServices(options: { baseDir: string; clock?: () => number }) {
  const db = getDatabase(options.baseDir).db;
  const uow = new SQLiteTodoUnitOfWork(db);
  const clock = options.clock ?? Date.now;
  return { db, uow, todos: new TodoApplicationService(uow, clock), scheduler: new TodoScheduler(uow), executions: new TodoExecutionService(uow, clock), notifications: new PersistentNotificationService(uow, clock) };
}
type TodoServices = ReturnType<typeof createTodoServices>;
export function todoServices(): TodoServices {
  const global = globalThis as typeof globalThis & { __todoServices?: TodoServices };
  return global.__todoServices ??= createTodoServices({ baseDir: getServerBaseDir() });
}
