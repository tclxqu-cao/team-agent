import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sessionCompletedAt } from "../lib/sidebar-session-status";
import type { SessionView } from "../../../core/src/application/session/SyncSessionViews";
import type { CatalogSession } from "../../../core/src/domain/supervision/types";

interface CompletionReceipt {
  completedAt?: number;
  viewedAt?: number;
}

interface SessionCompletionState {
  receipts: Record<string, CompletionReceipt>;
  sharedViews: ReadonlyMap<string, number>;
  recordCompletions(sessions: readonly Pick<CatalogSession, "id" | "status" | "updated" | "completedAt">[]): void;
  receiveViews(views: readonly SessionView[]): void;
  markViewed(id: string, viewedAt: number): void;
}

export function isUnreadCompletion(receipt: CompletionReceipt | undefined, completedAt?: string, sharedViewedAt = 0): boolean {
  const listedCompletion = completedAt ? Date.parse(completedAt) : 0;
  return Math.max(listedCompletion || 0, receipt?.completedAt ?? 0) > Math.max(receipt?.viewedAt ?? 0, sharedViewedAt);
}

export const useSessionCompletionStore = create<SessionCompletionState>()(persist(
  (set, get) => ({
    receipts: {},
    sharedViews: new Map(),
    recordCompletions(sessions) {
      const previous = get().receipts;
      let receipts = previous;
      for (const session of sessions) {
        const timestamp = sessionCompletedAt(session);
        if (!timestamp) continue;
        const completedAt = Date.parse(timestamp);
        const receipt = receipts[session.id];
        if (!(completedAt > (receipt?.completedAt ?? 0))) continue;
        if (receipts === previous) receipts = { ...previous };
        receipts[session.id] = { ...receipt, completedAt };
      }
      if (receipts !== previous) set({ receipts });
    },
    receiveViews(views) {
      if (!views.length) return;
      const sharedViews = new Map(get().sharedViews);
      for (const { sessionId, viewedAt } of views) {
        sharedViews.set(sessionId, Math.max(viewedAt, sharedViews.get(sessionId) ?? 0));
      }
      set({ sharedViews });
    },
    markViewed(id, viewedAt) {
      const { receipts, sharedViews } = get();
      if (viewedAt <= Math.max(receipts[id]?.viewedAt ?? 0, sharedViews.get(id) ?? 0)) return;
      set({ receipts: { ...receipts, [id]: { ...receipts[id], viewedAt } } });
    },
  }),
  { name: "agentroam.session-completion.v1", partialize: ({ receipts }) => ({ receipts }) },
));
