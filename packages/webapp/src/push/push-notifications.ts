import type { HttpClient } from "../infrastructure/http/http-client.js";

const SERVICE_WORKER_URL = "/service-worker.js";

function supported(): boolean {
  return typeof window !== "undefined"
    && window.isSecureContext === true
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

async function subscribe(http: HttpClient): Promise<void> {
  const { publicKey } = await http.get<{ publicKey?: string }>("/api/push/vapid");
  if (!publicKey) return;
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await http.post("/api/push/subscribe", subscription.toJSON());
}

/**
 * Arms Web Push for the phone: subscriptions survive offline/tab-closed, so
 * approval requests and run completions reach the lock screen. Browsers only
 * grant the permission from a user gesture — when it is still "default" the
 * first tap arms it; granted devices re-assert the subscription on every boot.
 * Everything fails quiet: push is an optional capability, never a blocker.
 */
export function startPushNotifications(http: HttpClient): void {
  if (!supported()) return;
  void (async () => {
    try {
      if (Notification.permission === "granted") {
        await subscribe(http);
        return;
      }
      if (Notification.permission !== "default") return;
      const arm = () => {
        void (async () => {
          try {
            const permission = await Notification.requestPermission();
            if (permission === "granted") await subscribe(http);
          } catch { /* 静默失败：推送是可选能力 */ }
        })();
      };
      document.addEventListener("pointerdown", arm, { once: true });
    } catch { /* 静默失败：未配对或推送不可用 */ }
  })();
}
