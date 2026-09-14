import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const DEVICE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const failure = (message, status = 401) => Object.assign(new Error(message), { status });

/** Separate additive storage: existing workspace/user data is never migrated or reset. */
export class DevicePairingStore {
  constructor(dataDir, now = Date.now) {
    this.now = now;
    const directory = join(dataDir, ".agentroam-auth");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, "devices.sqlite");
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_code (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER);
      CREATE TABLE IF NOT EXISTS remote_access (id INTEGER PRIMARY KEY CHECK(id=1), locked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_qr (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT, expires INTEGER NOT NULL);
      INSERT OR IGNORE INTO remote_access VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS pairing_requests (id TEXT PRIMARY KEY, claim_hash TEXT UNIQUE, name TEXT NOT NULL, phrase TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT, target TEXT, outcome TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS device_nonces (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
    if (!this.db.pragma("table_info(security_audit)").some((column) => column.name === "count")) this.db.exec("ALTER TABLE security_audit ADD COLUMN count INTEGER NOT NULL DEFAULT 1");
    this.db.exec("CREATE INDEX IF NOT EXISTS audit_action_time ON security_audit(action,at)");
  }

  createCode() {
    return this.db.transaction(() => {
      this.requireUnlocked();
      this.db.prepare("DELETE FROM pairing_qr").run();
      const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
      const expiresAt = this.now() + CODE_MS;
      this.db.prepare("INSERT OR REPLACE INTO pairing_code VALUES (1, ?, ?, 0)").run(hash(code), expiresAt);
      this.audit("pair.code.created", "local", null, "success");
      return { code, expiresAt };
    }).immediate();
  }

  exchange(code, name) {
    // Failed-attempt updates must commit too: throw only outside the transaction.
    const result = this.db.transaction(() => {
      this.requireUnlocked();
      this.expireRequests();
      const now = this.now();
      const active = this.db.prepare("SELECT * FROM pairing_code WHERE id=1").get();
      if (!active || active.expires <= now) return { error: "配对码无效或已过期，请在电脑上生成新码" };
      if (active.attempts >= 5) return { error: "尝试次数过多，请在电脑上生成新码", status: 429 };
      if (typeof code !== "string" || !timingSafeEqual(Buffer.from(hash(code.replace(/[\s-]/g, ""))), Buffer.from(active.hash))) {
        this.db.prepare("UPDATE pairing_code SET attempts=attempts+1 WHERE id=1").run();
        return { error: "配对码错误", status: active.attempts >= 4 ? 429 : 401 };
      }
      const claimToken = secret();
      const words = ["松林", "月光", "海风", "白云", "星河", "青山", "晨露", "花园", "灯塔", "飞鸟", "微雨", "竹叶", "清泉", "晚霞", "雪峰", "麦田"];
      const phrase = `${words[randomInt(words.length)]}·${words[randomInt(words.length)]}·${String(randomInt(10000)).padStart(4, "0")}`;
      const request = { id: randomUUID(), name: (typeof name === "string" ? name.trim() : "").slice(0, 80) || "我的设备", phrase, created: now, expires: now + CODE_MS, status: "waiting" };
      this.db.prepare("INSERT INTO pairing_requests VALUES (?, ?, ?, ?, ?, ?, ?)").run(request.id, hash(claimToken), request.name, phrase, now, request.expires, request.status);
      this.db.prepare("DELETE FROM pairing_code WHERE id=1").run();
      this.db.prepare("DELETE FROM pairing_qr").run();
      this.audit("pair.requested", "remote", request.id, "waiting");
      return { claimToken, request };
    }).immediate();
    if (result.error) { this.audit("pair.failed", "remote", null, "denied"); throw failure(result.error, result.status); }
    return result;
  }

  createQr() {
    return this.db.transaction(() => {
      this.requireUnlocked();
      const grant = secret(); const expiresAt = this.now() + CODE_MS;
      this.db.prepare("INSERT OR REPLACE INTO pairing_qr VALUES (1, ?, ?)").run(hash(grant), expiresAt);
      this.audit("pair.qr.created", "local", null, "success");
      return { grant, expiresAt };
    }).immediate();
  }

  qrClaimed() { return !!this.db.prepare("SELECT id FROM pairing_qr WHERE hash IS NULL AND expires>?").get(this.now()); }

  exchangeQr(grant, name) {
    return this.db.transaction(() => {
      this.requireUnlocked();
      if (typeof grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant)) throw failure("授权二维码无效或已过期", 410);
      const row = this.db.prepare("UPDATE pairing_qr SET hash=NULL WHERE id=1 AND hash=? AND expires>? RETURNING id").get(hash(grant), this.now());
      if (!row) throw failure("授权二维码无效、已使用或已过期，请在电脑上重新生成", 410);
      const token = secret(); const now = this.now();
      const device = { id: randomUUID(), name: (typeof name === "string" ? name.trim() : "").slice(0, 80) || "我的 App", created: now, seen: now, expires: now + DEVICE_SESSION_MS };
      this.db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, NULL)").run(device.id, hash(token), device.name, now, now, device.expires);
      this.db.prepare("DELETE FROM pairing_code").run();
      this.audit("pair.qr.claimed", device.id, null, "success");
      this.audit("device.authorized", device.id, null, "success");
      return { token, device };
    }).immediate();
  }

  authenticate(token) {
    if (this.isLocked()) return null;
    if (typeof token !== "string" || token.length > 256) return null;
    return this.db.prepare("SELECT id, name, created, seen, expires FROM devices WHERE token_hash=? AND revoked IS NULL AND expires>?").get(hash(token), this.now()) || null;
  }

  active(id) {
    if (this.isLocked()) return false;
    return !!this.db.prepare("SELECT id FROM devices WHERE id=? AND revoked IS NULL AND expires>?").get(id, this.now());
  }

  renew(id) {
    const now = this.now();
    this.db.prepare("UPDATE devices SET seen=?, expires=? WHERE id=? AND revoked IS NULL AND expires>?").run(now, now + DEVICE_SESSION_MS, id, now);
  }

  issueNonce(id) {
    if (!this.active(id)) throw failure("设备授权已失效");
    const nonce = secret();
    this.db.prepare("DELETE FROM device_nonces WHERE expires<=?").run(this.now());
    this.db.prepare("INSERT INTO device_nonces VALUES (?, ?, ?)").run(hash(nonce), id, this.now() + 60_000);
    return nonce;
  }

  consumeNonce(id, nonce) {
    if (typeof nonce !== "string" || !this.active(id)) return false;
    return !!this.db.prepare("DELETE FROM device_nonces WHERE hash=? AND device_id=? AND expires>? RETURNING hash").get(hash(nonce), id, this.now());
  }

  list() {
    return this.db.prepare("SELECT id, name, created, seen, expires FROM devices WHERE revoked IS NULL AND expires>? ORDER BY created").all(this.now());
  }

  revoke(id, actor = "local") {
    return this.db.transaction(() => {
      const count = this.db.prepare("UPDATE devices SET revoked=? WHERE id=? AND revoked IS NULL").run(this.now(), id).changes;
      this.audit("device.revoked", actor, id, count ? "success" : "not_found");
      return count;
    }).immediate();
  }

  revokeAll() {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM pairing_code").run();
      this.db.prepare("DELETE FROM pairing_qr").run();
      this.db.prepare("UPDATE pairing_requests SET status='cancelled', claim_hash=NULL WHERE status IN ('waiting','approved')").run();
      this.db.prepare("DELETE FROM device_nonces").run();
      const count = this.db.prepare("UPDATE devices SET revoked=? WHERE revoked IS NULL").run(this.now()).changes;
      this.audit("devices.revoked_all", "local", null, "success");
      return count;
    }).immediate();
  }

  isLocked() { return this.db.prepare("SELECT locked FROM remote_access WHERE id=1").get().locked === 1; }
  requireUnlocked() { if (this.isLocked()) throw failure("远程访问已锁定，请在电脑上解锁", 423); }

  lock() {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE remote_access SET locked=1 WHERE id=1").run();
      const revoked = this.revokeAll();
      this.audit("remote.locked", "local", null, "success");
      return { locked: true, revoked };
    }).immediate();
  }

  unlock() {
    this.db.transaction(() => {
      this.db.prepare("UPDATE remote_access SET locked=0 WHERE id=1").run();
      this.audit("remote.unlocked", "local", null, "success");
    }).immediate();
    return { locked: false };
  }

  expireRequests() {
    const expired = this.db.prepare("UPDATE pairing_requests SET status='expired', claim_hash=NULL WHERE expires<=? AND status IN ('waiting','approved') RETURNING id").all(this.now());
    for (const row of expired) this.audit("pair.expired", "system", row.id, "expired");
    this.db.prepare("DELETE FROM pairing_requests WHERE expires<?").run(this.now() - DEVICE_SESSION_MS);
  }

  pending() {
    this.expireRequests();
    return this.db.prepare("SELECT id, name, phrase, created, expires, status FROM pairing_requests WHERE status='waiting' ORDER BY created").all();
  }

  decide(id, phrase, approve) {
    this.requireUnlocked();
    this.expireRequests();
    return this.db.transaction(() => {
      this.requireUnlocked();
      const request = this.db.prepare("SELECT * FROM pairing_requests WHERE id=? AND status='waiting' AND expires>?").get(id, this.now());
      if (!request) throw failure("请求已过期或已处理", 410);
      if (approve && phrase !== request.phrase) throw failure("核对短语不匹配", 409);
      const status = approve ? "approved" : "denied";
      this.db.prepare("UPDATE pairing_requests SET status=? WHERE id=?").run(status, id);
      this.audit(approve ? "pair.approved" : "pair.denied", "local", id, status);
      return { id, status };
    }).immediate();
  }

  poll(claimToken) {
    this.requireUnlocked();
    this.expireRequests();
    if (typeof claimToken !== "string" || claimToken.length > 256) throw failure("没有待授权请求", 410);
    return this.db.transaction(() => {
      this.requireUnlocked();
      const request = this.db.prepare("SELECT * FROM pairing_requests WHERE claim_hash=? AND expires>?").get(hash(claimToken), this.now());
      if (!request) throw failure("请求已过期或已取消，请重新配对", 410);
      const { id, name, phrase, expires, status } = request;
      if (status !== "approved") return { request: { id, name, phrase, expires, status } };
      const token = secret(); const now = this.now();
      const device = { id: randomUUID(), name, created: now, seen: now, expires: now + DEVICE_SESSION_MS };
      this.db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, NULL)").run(device.id, hash(token), name, now, now, device.expires);
      this.db.prepare("UPDATE pairing_requests SET status='claimed', claim_hash=NULL WHERE id=?").run(id);
      this.audit("device.authorized", device.id, id, "success");
      return { token, device };
    }).immediate();
  }

  /** Metadata only. Reject arbitrary client-controlled strings before persistence. */
  audit(action, actor, target, outcome) {
    if (!/^[a-z][a-z0-9_.:-]{0,79}$/.test(action) || !["success", "denied", "waiting", "approved", "expired", "failed", "not_found", "started"].includes(outcome)) throw new Error("Invalid audit event");
    const safeId = (value) => typeof value === "string" && (/^[a-f0-9-]{36}$/.test(value) || ["local", "desktop", "sdk", "remote", "system"].includes(value)) ? value : null;
    if (action === "pair.failed") {
      const recent = this.db.prepare("SELECT id FROM security_audit WHERE action=? AND at>=? ORDER BY id DESC LIMIT 1").get(action, this.now() - 60_000);
      if (recent) { this.db.prepare("UPDATE security_audit SET count=count+1 WHERE id=?").run(recent.id); return; }
    }
    this.db.prepare("INSERT INTO security_audit (at,action,actor,target,outcome) VALUES (?,?,?,?,?)").run(this.now(), action, safeId(actor), safeId(target), outcome);
  }

  auditEvents(limit = 100) {
    const count = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100));
    return this.db.prepare("SELECT id,at,action,actor,target,outcome,count FROM security_audit ORDER BY id DESC LIMIT ?").all(count);
  }

  close() { this.db.close(); }
}
