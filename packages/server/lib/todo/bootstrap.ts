import { todoServices } from "./todo-service";
import { dispatchScheduledTodos } from "./scheduled-todo-runner";
import { serverLogger } from "../global-logger";
export function startTodoWorkers(): void {
  const g = globalThis as typeof globalThis & { __todoWorker?: ReturnType<typeof setInterval> };
  if (g.__todoWorker) return;
  let ticking = false;
  const tick = async () => {
    if (ticking) return; ticking = true;
    try { todoServices().scheduler.tick(Date.now()); await dispatchScheduledTodos(); }
    catch (error) { serverLogger().warn("Todo worker tick failed", { error: error instanceof Error ? error.message : String(error) }); }
    finally { ticking = false; }
  };
  g.__todoWorker = setInterval(() => { void tick(); }, 1000); g.__todoWorker.unref(); void tick();
}
