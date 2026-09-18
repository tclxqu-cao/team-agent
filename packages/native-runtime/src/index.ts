// ── @agent/native-runtime ──
// Shared native runtime (broker host/client, per-agent adapters, workspace index,
// cron scheduler, sub-agent dispatcher).
//
// Both the Node server (web console + installed service) and the Electron desktop
// main process consume it through this single entry point, so neither has to
// reach into the other package's source tree.

export * from "./agent-runtime/index.js";
export * from "./agent-runtime/session-id.js";
export { CronScheduler } from "./cron/cronScheduler.js";
export { CronTasksLock } from "./cron/cronTasksLock.js";
export { SubAgentDispatcher } from "./sub-agent-dispatcher.js";
export type { EmitFn, RegisterSessionToolsFn } from "./sub-agent-dispatcher.js";
