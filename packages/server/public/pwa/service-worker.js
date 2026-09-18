const CACHE = "agentroam-public-offline-v1";
const OFFLINE = "/pwa/offline.html";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(new Request(OFFLINE, { cache: "reload", credentials: "omit" }))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("agentroam-public-offline-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  // Never cache or replay authenticated pages, API responses, files or operations.
  if (event.request.mode === "navigate" && event.request.method === "GET" && new URL(event.request.url).origin === self.location.origin) {
    event.respondWith(fetch(new Request(event.request, { cache: "no-store" })).catch(async () => (await caches.match(OFFLINE)) || new Response("无法连接电脑，请检查网络后重试。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })));
  }
});

// Web Push: surface remote run/approval notifications while no client is watching.
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "AgentRoam";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof payload.body === "string" ? payload.body : "",
    tag: typeof payload.tag === "string" && payload.tag ? payload.tag : "agentroam",
    icon: "/pwa/icon-192.png",
    data: { url: typeof payload.url === "string" && payload.url ? payload.url : "/app/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/app/";
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientList) {
      if (!("focus" in client)) continue;
      if ("navigate" in client) client.navigate(target).catch(() => {});
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
