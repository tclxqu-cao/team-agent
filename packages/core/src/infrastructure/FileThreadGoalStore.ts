// ── File Thread Goal Store ──
// 文件型 IThreadGoalStore，供 TUI 等 in-process 宿主使用（其会话存储本就是
// FileSystemSessionStore，不共享 server 的 SQLite）。写穿持久化到单个 JSON 文件。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IThreadGoalStore, ThreadGoal } from '../domain/goal/ThreadGoal.js';
import { isThreadGoalStatus } from '../domain/goal/ThreadGoal.js';

function isThreadGoal(value: unknown): value is ThreadGoal {
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<ThreadGoal>;
  return typeof goal.sessionId === "string"
    && typeof goal.objective === "string"
    && isThreadGoalStatus(goal.status)
    && (goal.tokenBudget === null || typeof goal.tokenBudget === "number")
    && typeof goal.tokensUsed === "number"
    && typeof goal.timeUsedSeconds === "number"
    && typeof goal.turnCount === "number"
    && typeof goal.createdAt === "string"
    && typeof goal.updatedAt === "string";
}

export class FileThreadGoalStore implements IThreadGoalStore {
  private readonly filePath: string;

  constructor(storeDir: string) {
    mkdirSync(storeDir, { recursive: true });
    this.filePath = join(storeDir, "thread-goals.json");
  }

  private readAll(): Map<string, ThreadGoal> {
    try {
      if (!existsSync(this.filePath)) return new Map();
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { goals?: unknown }).goals)) return new Map();
      const rows = (parsed as { goals: unknown[] }).goals.filter(isThreadGoal) as ThreadGoal[];
      return new Map(rows.map((goal) => [goal.sessionId, goal]));
    } catch {
      return new Map();
    }
  }

  private writeAll(rows: Map<string, ThreadGoal>): void {
    writeFileSync(this.filePath, `${JSON.stringify({ version: 1, goals: [...rows.values()] }, null, 2)}\n`);
  }

  async get(sessionId: string): Promise<ThreadGoal | null> {
    return this.readAll().get(sessionId) ?? null;
  }

  async set(goal: ThreadGoal): Promise<void> {
    const rows = this.readAll();
    rows.set(goal.sessionId, goal);
    this.writeAll(rows);
  }

  async clear(sessionId: string): Promise<boolean> {
    const rows = this.readAll();
    const existed = rows.delete(sessionId);
    if (existed) this.writeAll(rows);
    return existed;
  }

  async listActive(): Promise<ThreadGoal[]> {
    return [...this.readAll().values()].filter((goal) => goal.status === "active");
  }
}
