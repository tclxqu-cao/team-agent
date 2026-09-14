import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One descriptor per server process; never overwrite another running server. */
export function createDesktopDiscovery({ dataDir, directory = process.env.AGENTROAM_DISCOVERY_DIR || join(homedir(), ".agentroam", "services") }) {
  const instanceId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const file = join(directory, `${instanceId}.json`);
  let descriptor;
  const authenticate = (req) => {
    const value = req.headers["x-agentroam-desktop-token"];
    const remote = req.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return false;
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
      && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };
  const onExit = () => { try { unlinkSync(file); } catch {} };
  return {
    authenticate,
    headers: () => ({ "x-agentroam-desktop-token": token }),
    async publish(port) {
      descriptor = { protocol: 1, instanceId, pid: process.pid, url: `http://127.0.0.1:${port}`, dataDir: resolve(dataDir), token };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
      await rename(temporary, file);
      process.once("exit", onExit);
    },
    handle(req, res) {
      if (req.url?.split("?")[0] !== "/api/desktop/identity") {
        // An explicit desktop credential must never silently downgrade to an
        // anonymous request after a restart or a port is reused.
        if (req.headers["x-agentroam-desktop-token"] && !authenticate(req)) {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Desktop service identity changed" }));
          return true;
        }
        return false;
      }
      if (!authenticate(req) || !descriptor) {
        res.writeHead(401).end();
        return true;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ protocol: 1, instanceId, dataDir: descriptor.dataDir }));
      return true;
    },
    async close() {
      process.removeListener("exit", onExit);
      await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    },
  };
}
