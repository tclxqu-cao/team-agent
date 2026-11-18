import { useCallback, useEffect, useRef, useState } from "react";
import type { PersistentNotification } from "@agent/core";
import { NotificationToastInbox, type NotificationSnapshot } from "./notification-toast-inbox";

/** Mounted once by the desktop shell, independent of its current page or chat pane. */
export function useNotificationToasts(enabled: boolean) {
  const [items, setItems] = useState<PersistentNotification[]>([]);
  const inbox = useRef<NotificationToastInbox>();
  useEffect(() => {
    if (!enabled || !window.agentApi?.notificationList || !window.agentApi.notificationRead) return;
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Read state is still saved by the service. */ }
    const current = new NotificationToastInbox({
      list: async () => await window.agentApi.notificationList!() as NotificationSnapshot,
      read: (id, scope) => window.agentApi.notificationRead!(id, scope),
    }, storage, error => console.warn("[notifications] read synchronization failed", error));
    inbox.current = current;
    const stop = current.subscribe(setItems);
    const refresh = () => { void current.refresh(); };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      stop();
      if (inbox.current === current) inbox.current = undefined;
    };
  }, [enabled]);
  const consume = useCallback((notification: PersistentNotification) => {
    void inbox.current?.consume(notification);
  }, []);
  const clearAll = useCallback(() => {
    void inbox.current?.consumeAll();
  }, []);
  return { items, consume, clearAll };
}
