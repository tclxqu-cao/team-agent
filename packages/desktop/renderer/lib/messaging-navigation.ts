import { MESSAGING_OPEN, MESSAGING_OPEN_QUERY } from "../../../core/src/domain/web-console/MessagingBridge";

let pending: Promise<void> | undefined;

/** An iframe can update while its parent still runs a pre-messaging shell. */
export function openShellMessaging(): Promise<void> {
  if (pending) return pending;
  const parent = window.parent;
  const origin = window.location.origin;
  pending = new Promise<void>((resolve, reject) => {
    let observer: MutationObserver | undefined;
    const cleanup = () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
    const confirm = (): boolean => {
      try {
        if (!parent.document.querySelector('.terminal-tab.active[data-terminal-id="messaging"]')) return false;
      } catch { return false; }
      try {
        const url = new URL(parent.location.href);
        if (url.searchParams.get(MESSAGING_OPEN_QUERY) === "messaging") {
          url.searchParams.delete(MESSAGING_OPEN_QUERY);
          parent.history.replaceState(parent.history.state, "", url.href);
        }
      } catch { /* Navigation succeeded even if URL cleanup is unavailable. */ }
      cleanup();
      resolve();
      return true;
    };
    const timer = setTimeout(() => {
      if (confirm()) return;
      cleanup();
      try {
        const url = new URL(parent.location.href);
        url.searchParams.set(MESSAGING_OPEN_QUERY, "messaging");
        parent.location.assign(url.href);
        resolve();
      } catch {
        reject(new Error("消息接入未打开，请刷新页面后重试"));
      }
    }, 1500);
    try {
      observer = new MutationObserver(confirm);
      observer.observe(parent.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      parent.postMessage({ type: MESSAGING_OPEN }, origin);
      confirm();
    } catch {
      cleanup();
      reject(new Error("消息接入未打开，请刷新页面后重试"));
    }
  }).finally(() => { pending = undefined; });
  return pending;
}
