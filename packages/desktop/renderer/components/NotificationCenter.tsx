import { useCallback, useEffect, useState } from "react";
import type { PersistentNotification } from "@agent/core";
import "../styles/todos.css";
export default function NotificationCenter({ onOpen }: { onOpen: (target: PersistentNotification) => void }) {
  const [items, setItems] = useState<PersistentNotification[]>([]), [error, setError] = useState("");
  const load = useCallback(async () => { try { setItems((await window.agentApi?.notificationList?.())?.items.slice().reverse() ?? []); } catch (e) { setError(e instanceof Error ? e.message : "通知读取失败"); } }, []);
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 5000); return () => clearInterval(timer); }, [load]);
  return <section className="todo-notifications" aria-label="通知中心"><h2>通知 <small>{items.filter(n => !n.readAt && !n.dismissedAt).length} 未读</small></h2>{error && <p role="alert">{error}</p>}{!items.length && <p>暂时没有通知</p>}{items.map(n => <button key={n.id} className={n.readAt || n.dismissedAt ? "is-read" : ""} onClick={() => { void window.agentApi?.notificationRead?.(n.id).then(() => load()); onOpen(n); }}><strong>{n.title}</strong><span>{n.body}</span><time>{new Date(n.createdAt).toLocaleString()}{n.dismissedAt ? " · 已处理" : ""}</time></button>)}</section>;
}
