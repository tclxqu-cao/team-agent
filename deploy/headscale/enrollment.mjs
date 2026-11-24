import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHeadscaleClient } from "./headscale-client.mjs";

const prefix = "/agentroam-enrollment/v1";
const isSecret = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");

process.umask(0o077);
const db = new DatabaseSync(join(process.env.STATE_DIRECTORY, "enrollment.sqlite"));
db.exec(`
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS invitations (
    code TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    credential TEXT UNIQUE,
    window_until INTEGER NOT NULL DEFAULT 0,
    issued INTEGER NOT NULL DEFAULT 0
  );
`);

const args = process.argv.slice(2);
if (args[0] === "invite") {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 30 * 60_000;
  db.prepare("DELETE FROM invitations WHERE expires_at <= ? AND credential IS NULL").run(Date.now());
  db.prepare("INSERT INTO invitations (code, expires_at) VALUES (?, ?)").run(digest(code), expiresAt);
  console.log(code);
} else if (args[0] === "revoke") {
  // Read the invite from stdin so it stays out of process listings and shell history.
  const code = readFileSync(0, "utf8").trim();
  if (!isSecret(code)) throw new Error("Invalid invitation");
  db.prepare("DELETE FROM invitations WHERE code = ?").run(digest(code));
} else {
  const loginServer = new URL(process.env.ENROLLMENT_PUBLIC_URL).origin;
  const headscale = createHeadscaleClient({
    baseUrl: process.env.ENROLLMENT_HEADSCALE_URL,
    apiKey: readFileSync(process.env.ENROLLMENT_HEADSCALE_KEY_FILE, "utf8").trim(),
  });
  const activate = db.prepare(`
    UPDATE invitations SET credential = ?
    WHERE code = ? AND ((credential IS NULL AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM invitations WHERE credential = ?)) OR credential = ?)
    RETURNING code
  `);
  const lookup = db.prepare("SELECT code FROM invitations WHERE credential = ?");
  const useQuota = db.prepare(`
    UPDATE invitations
    SET issued = CASE WHEN window_until <= ? THEN 1 ELSE issued + 1 END,
        window_until = CASE WHEN window_until <= ? THEN ? ELSE window_until END
    WHERE credential = ? AND (window_until <= ? OR issued < 20)
  `);
  const username = (code) => `agentroam-invite-${code.slice(0, 24)}`;
  const respond = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  const error = (res, status, message) => respond(res, status, { error: message });

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (req, res) => {
    try {
      if (req.method === "GET" && req.url === `${prefix}/health`) return respond(res, 200, { status: "pass" });
      const nodeId = /^\/agentroam-enrollment\/v1\/nodes\/([1-9]\d*)$/.exec(req.url)?.[1];
      const activation = req.method === "POST" && req.url === `${prefix}/activate`;
      const mint = req.method === "POST" && req.url === `${prefix}/node-key`;
      const list = req.method === "GET" && req.url === `${prefix}/nodes`;
      const remove = req.method === "DELETE" && nodeId;
      if (!activation && !mint && !list && !remove) return error(res, 404, "Unknown enrollment route");
      const credential = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!credential) return error(res, 401, "Enrollment credential required");
      const hash = digest(credential);
      if (activation) {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024) {
            // End the response before Node drains the oversized request.
            res.setHeader("connection", "close");
            return error(res, 413, "Request too large");
          }
        }
        let code;
        try { code = JSON.parse(body)?.code; } catch { /* Invalid JSON is an invalid invitation. */ }
        if (!isSecret(code)) return error(res, 400, "Invalid invitation");
        const row = activate.get(hash, digest(code), Date.now(), hash, hash);
        return row
          ? respond(res, 200, { loginServer, user: username(row.code) })
          : error(res, 403, "Invitation expired, invalid or already used");
      }
      const row = lookup.get(hash);
      if (!row) return error(res, 403, "Invalid enrollment credential");
      const user = username(row.code);
      if (mint) {
        const now = Date.now();
        if (!useQuota.run(now, now, now + 3_600_000, hash, now).changes) return error(res, 429, "Node key limit reached");
        const { key, expiresAt } = await headscale.createPreAuthKey(await headscale.getOrCreateUser(user));
        return respond(res, 200, { authkey: key, expiresAt, user, loginServer });
      }
      const nodes = (await headscale.listNodes()).filter(node => node.user === user);
      if (list) return respond(res, 200, { nodes });
      if (!nodes.some(node => node.id === nodeId)) return error(res, 404, "Node not found");
      try { await headscale.deleteNode(nodeId); }
      catch (cause) { if (cause.status !== 404) throw cause; }
      return respond(res, 200, { ok: true });
    } catch (cause) {
      // Upstream responses can contain sensitive details. Record only the failure class.
      console.error("Enrollment request failed", cause.name, cause.status ?? cause.code ?? "");
      return error(res, 502, "Enrollment request failed");
    }
  });
  server.listen(Number(process.env.ENROLLMENT_PORT ?? 18081), "127.0.0.1");
}
