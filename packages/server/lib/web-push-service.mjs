import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import webpush from "web-push";

const json = (value) => JSON.stringify(value ?? null);

/**
 * Web Push fan-out for paired devices: VAPID key persistence, push
 * subscription storage, and best-effort delivery. Storage is additive
 * SQLite next to the pairing store — existing data is never touched.
 *
 * Delivery failures are swallowed on purpose: a push is a convenience
 * signal, and an unreachable endpoint (expired, uninstalled PWA) is
 * dropped from the table instead of retried.
 */
export class WebPushService {
  constructor(dataDir, now = Date.now) {
    this.now = now;
    const directory = resolve(dataDir, ".agentroam-auth");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "push.sqlite");
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_keys (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint_hash TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        device_id TEXT,
        created INTEGER NOT NULL
      );
    `);
    this.keys = this.loadKeys();
    this.lastNotified = new Map();
  }

  loadKeys() {
    const row = this.db.prepare("SELECT public_key, private_key FROM push_keys WHERE id=1").get();
    if (row) return { publicKey: row.public_key, privateKey: row.private_key };
    const generated = webpush.generateVAPIDKeys();
    this.db.prepare("INSERT INTO push_keys VALUES (1, ?, ?)").run(generated.publicKey, generated.privateKey);
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  }

  getPublicKey() {
    return this.keys.publicKey;
  }

  saveSubscription(deviceId, subscription) {
    const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint : "";
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!endpoint.startsWith("https://") || typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) {
      throw Object.assign(new Error("Invalid push subscription"), { status: 400 });
    }
    this.db.prepare(`
      INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth, device_id, created)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_hash) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, device_id=excluded.device_id
    `).run(endpointHash(endpoint), endpoint, p256dh, auth, typeof deviceId === "string" ? deviceId : null, this.now());
    return { ok: true };
  }

  deleteSubscription(endpoint) {
    if (typeof endpoint !== "string" || !endpoint) {
      throw Object.assign(new Error("Endpoint required"), { status: 400 });
    }
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash=?").run(endpointHash(endpoint));
    return { ok: true };
  }

  listSubscriptions() {
    return this.db.prepare("SELECT endpoint, p256dh, auth, device_id FROM push_subscriptions").all()
      .map((row) => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth }, deviceId: row.device_id }));
  }

  /**
   * Fire-and-forget fan-out. Deduplicates per (session, kind) within a short
   * window so replayed/reattached streams cannot burst notifications.
   */
  notifySession({ sessionId, kind, title, body, url }) {
    const key = `${sessionId}\u001f${kind}`;
    const last = this.lastNotified.get(key) || 0;
    if (this.now() - last < 1_500) return;
    this.lastNotified.set(key, this.now());
    if (this.lastNotified.size > 500) {
      for (const [old, at] of this.lastNotified) if (this.now() - at > 60_000) this.lastNotified.delete(old);
    }
    void this.sendToAll({ title, body, tag: sessionId, url });
  }

  async sendToAll(payload) {
    const subscriptions = this.listSubscriptions();
    await Promise.allSettled(subscriptions.map((subscription) => this.send(subscription, payload)));
  }

  async send(subscription, payload) {
    try {
      webpush.setVapidDetails("mailto:agentroam@localhost", this.keys.publicKey, this.keys.privateKey);
      await webpush.sendNotification(subscription, json(payload), { TTL: 3600 });
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash=?").run(endpointHash(subscription.endpoint));
      }
    }
  }

  close() {
    this.db.close();
  }
}

function endpointHash(endpoint) {
  return createHash("sha256").update(endpoint).digest("hex");
}

let singleton = null;

/** Lazily-created process-wide instance; dataDir matches ws-server's AGENT_DATA_DIR resolution. */
export function getWebPushService(dataDir = process.env.AGENT_DATA_DIR?.trim() || process.cwd()) {
  singleton ??= new WebPushService(dataDir);
  return singleton;
}
