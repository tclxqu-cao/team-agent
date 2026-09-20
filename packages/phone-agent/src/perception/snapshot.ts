import type { UiSnapshot } from "./ui-tree.js";

/**
 * 最近一次 UI 树快照（phone_tap index 依赖它定位）。
 * MCP server 基本是单会话使用，全局保留一份即可；带 TTL 防止屏幕已变化还按旧坐标点。
 */
export class SnapshotStore {
  private snapshot: UiSnapshot | null = null;

  constructor(private readonly ttlMs: number = 30_000) {}

  set(snapshot: UiSnapshot): void {
    this.snapshot = snapshot;
  }

  get(): UiSnapshot | null {
    if (!this.snapshot) return null;
    if (Date.now() - this.snapshot.capturedAt > this.ttlMs) {
      this.snapshot = null;
      return null;
    }
    return this.snapshot;
  }

  node(index: number): UiSnapshot["nodes"][number] | null {
    return this.get()?.nodes.find((n) => n.index === index) ?? null;
  }
}
