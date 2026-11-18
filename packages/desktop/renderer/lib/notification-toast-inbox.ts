import type { PersistentNotification, TaskNotificationPreferences } from "@agent/core";

export interface NotificationSnapshot {
  serviceId: string;
  ownerId: string;
  items: PersistentNotification[];
  preferences?: TaskNotificationPreferences;
}

interface NotificationInboxApi {
  list(): Promise<NotificationSnapshot>;
  read(id: string, scope: { serviceId: string; ownerId: string }): Promise<unknown>;
}

type ReadJournal = Record<string, string[]>;
const JOURNAL_KEY = "agentroam.notification-read-pending.v1";

function scopeOf(snapshot: NotificationSnapshot): string {
  if (!snapshot.serviceId || !snapshot.ownerId) throw new Error("通知来源缺失");
  return JSON.stringify([snapshot.serviceId, snapshot.ownerId]);
}

function enabled(notification: PersistentNotification, preferences?: TaskNotificationPreferences): boolean {
  if (notification.kind === "completion") return preferences?.completionEnabled !== false;
  if (notification.kind === "approval") return preferences?.approvalEnabled !== false;
  return preferences?.todoEnabled !== false;
}

/** UI delivery state; the service remains the authority for durable read status. */
export class NotificationToastInbox {
  private scope = "";
  private items: PersistentNotification[] = [];
  private readonly pending: ReadJournal;
  private readonly consumed = new Map<string, Set<string>>();
  private refreshing?: Promise<void>;
  private syncing?: Promise<void>;
  private readonly listeners = new Set<(items: PersistentNotification[]) => void>();

  constructor(
    private readonly api: NotificationInboxApi,
    private readonly storage?: Pick<Storage, "getItem" | "setItem">,
    private readonly warn: (error: unknown) => void = () => {},
  ) {
    this.pending = {};
    try {
      const saved: unknown = JSON.parse(storage?.getItem(JOURNAL_KEY) ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [scope, ids] of Object.entries(saved)) {
          if (Array.isArray(ids)) this.pending[scope] = ids.filter((id): id is string => typeof id === "string");
        }
      }
    } catch (error) { this.warn(error); }
  }

  subscribe(listener: (items: PersistentNotification[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.items);
    return () => { this.listeners.delete(listener); };
  }

  private publish(items: PersistentNotification[]): void {
    this.items = items;
    this.listeners.forEach(listener => listener(items));
  }

  private save(): void {
    try { this.storage?.setItem(JOURNAL_KEY, JSON.stringify(this.pending)); }
    catch (error) { this.warn(error); }
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    try {
      const snapshot = await this.api.list();
      this.scope = scopeOf(snapshot);
      const suppressed = new Set([...(this.pending[this.scope] ?? []), ...(this.consumed.get(this.scope) ?? [])]);
      this.publish(snapshot.items.filter(notification => (
        notification.ownerId === snapshot.ownerId && !notification.readAt && !notification.dismissedAt
        && !suppressed.has(notification.id) && enabled(notification, snapshot.preferences)
      )).sort((left, right) => right.createdAt - left.createdAt));
      await this.syncReads(this.scope);
    } catch (error) { this.warn(error); }
  }

  /** Both opening and closing a toast consume it immediately, including while offline. */
  consume(notification: PersistentNotification): Promise<void> {
    return this.consumeItems([notification]);
  }

  consumeAll(): Promise<void> {
    return this.consumeItems(this.items);
  }

  private consumeItems(notifications: readonly PersistentNotification[]): Promise<void> {
    if (!this.scope || !notifications.length) return Promise.resolve();
    const selected = new Set(notifications.filter(notification => this.items.some(item => (
      item.id === notification.id && item.ownerId === notification.ownerId
    ))).map(notification => notification.id));
    if (!selected.size) return Promise.resolve();
    const scope = this.scope;
    const ids = this.pending[scope] ??= [];
    for (const id of selected) if (!ids.includes(id)) ids.push(id);
    this.save();
    this.publish(this.items.filter(item => !selected.has(item.id)));
    return this.syncReads(scope);
  }

  private syncReads(scope: string): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.flushReads(scope).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async flushReads(scope: string): Promise<void> {
    try {
      while (this.pending[scope]?.length) {
        // Recheck the selected service before every write; keep another service's
        // pending reads for when the user connects to that service again.
        const current = await this.api.list();
        if (scopeOf(current) !== scope) return;
        const id = this.pending[scope][0];
        const alreadyRead = current.items.some(item => item.id === id && (item.readAt || item.dismissedAt));
        if (!alreadyRead) await this.api.read(id, { serviceId: current.serviceId, ownerId: current.ownerId });
        const handled = this.consumed.get(scope) ?? new Set<string>();
        handled.add(id);
        this.consumed.set(scope, handled);
        this.pending[scope] = this.pending[scope].filter(pendingId => pendingId !== id);
        if (!this.pending[scope].length) delete this.pending[scope];
        this.save();
      }
    } catch (error) { this.warn(error); }
  }
}
