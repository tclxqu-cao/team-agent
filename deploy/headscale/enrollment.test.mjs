import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const exec = promisify(execFile);
const secret = () => randomBytes(32).toString("base64url");
const digest = value => createHash("sha256").update(value).digest("hex");
const listen = async server => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

test("broker binds an expiring invitation to one installation and scopes Headscale operations", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mesh-enrollment-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [from, name] of [
    ["./enrollment.mjs", "enrollment.mjs"],
    ["../../packages/server/lib/mesh/headscale-client.mjs", "headscale-client.mjs"],
  ]) await copyFile(new URL(from, import.meta.url), join(directory, name));
  const apiKey = secret();
  const keyFile = join(directory, "headscale.key");
  await writeFile(keyFile, apiKey);
  let expectedUser;
  const upstream = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const payload = body.length ? JSON.parse(Buffer.concat(body)) : null;
    const reply = (status, data) => res.writeHead(status).end(JSON.stringify(data));
    if (req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, {});
    switch (req.url) {
      case "/api/v1/user":
        return payload?.name === expectedUser ? reply(200, { user: { id: "8" } }) : reply(400, {});
      case "/api/v1/preauthkey":
        return payload?.user === "8" && payload.reusable === false && Date.parse(payload.expiration) > Date.now()
          ? reply(200, { preAuthKey: { key: "test-node-key", expiration: payload.expiration } }) : reply(400, {});
      case "/api/v1/node":
        return reply(200, { nodes: [{ id: "1", name: "own", user: { name: expectedUser } }, { id: "2", name: "other", user: { name: "other" } }] });
      case "/api/v1/node/1":
        return reply(req.method === "DELETE" ? 200 : 400, {});
      default:
        return reply(404, {});
    }
  });
  const headscalePort = await listen(upstream);
  t.after(() => upstream.close());
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const path = join(directory, "enrollment.mjs");
  const env = { ...process.env, STATE_DIRECTORY: directory, ENROLLMENT_PORT: String(port),
    ENROLLMENT_HEADSCALE_KEY_FILE: keyFile, ENROLLMENT_HEADSCALE_URL: `http://127.0.0.1:${headscalePort}`,
    ENROLLMENT_PUBLIC_URL: "https://headscale.example.test" };
  const invite = async () => (await exec(process.execPath, [path, "invite"], { env })).stdout.trim();
  const [code, expired] = [await invite(), await invite()];
  expectedUser = `agentroam-invite-${digest(code).slice(0, 24)}`;
  const db = new DatabaseSync(join(directory, "enrollment.sqlite"));
  db.prepare("UPDATE invitations SET expires_at=0 WHERE code=?").run(digest(expired));
  db.close();
  const processHandle = spawn(process.execPath, [path], { env, stdio: "ignore" });
  t.after(async () => {
    if (processHandle.exitCode === null) {
      processHandle.kill();
      await once(processHandle, "exit");
    }
  });
  const api = (name, method = "GET", token, body) => fetch(`http://127.0.0.1:${port}/agentroam-enrollment/v1/${name}`, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (let i = 0; i < 100; i++) {
    if (await api("health").then(r => r.ok, () => false)) break;
    if (i === 99) assert.fail("broker never started");
    await delay(40);
  }
  const [first, second] = [secret(), secret()];
  const activate = (token, code) => api("activate", "POST", token, { code });
  assert.equal((await activate(first, expired)).status, 403);
  const attempts = await Promise.all([activate(first, code), activate(second, code)]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 403]);
  const [winner, loser] = attempts[0].ok ? [first, second] : [second, first];
  assert.equal((await activate(winner, code)).status, 200);
  assert.equal((await activate(winner, await invite())).status, 403);
  assert.equal((await api("node-key", "POST")).status, 401);
  assert.equal((await api("node-key", "POST", loser)).status, 403);
  assert.match((await api("node-key", "POST", winner).then(r => r.json())).authkey, /^test-node-key$/);
  assert.deepEqual((await api("nodes", "GET", winner).then(r => r.json())).nodes.map(node => node.id), ["1"]);
  assert.equal((await api("nodes/2", "DELETE", winner)).status, 404);
  assert.equal((await api("nodes/1", "DELETE", winner)).status, 200);
});
