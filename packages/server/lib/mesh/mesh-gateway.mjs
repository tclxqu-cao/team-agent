import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { HeadscaleHttpError } from "./headscale-client.mjs";
import { createMeshService } from "./mesh-service.mjs";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw httpError(415, "JSON required");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw httpError(413, "Request too large");
  }
  let value;
  try { value = JSON.parse(body || "{}"); } catch { throw httpError(400, "Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "JSON object required");
  return value;
}

function nodeName(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) {
    throw httpError(400, "设备名只能使用字母、数字和中划线");
  }
  return value.toLowerCase();
}

/** The parent CLI owns the userspace daemon. Requests correlate only over private IPC. */
export function createMeshRuntimeBridge(parent = process) {
  const pending = new Map();
  const receive = message => {
    if (message?.type === "agentroam:mesh-result") pending.get(message.id)?.(message.error);
  };
  const disconnect = () => {
    for (const finish of pending.values()) finish("组网服务进程已断开", 503);
  };
  parent.on("message", receive);
  parent.on("disconnect", disconnect);
  return {
    run(action, name) {
      if (!parent.connected) throw httpError(503, "组网需要由 AgentRoam CLI 启动服务");
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const finish = (error, status = 502) => {
          clearTimeout(timer);
          pending.delete(id);
          if (error) reject(httpError(status, error)); else resolve();
        };
        const timer = setTimeout(() => finish("组网操作等待超时，请查看组网状态", 504), 120_000);
        pending.set(id, finish);
        try {
          parent.send({ type: "agentroam:mesh-run", id, action, name }, error => {
            if (error) finish("无法联系组网服务进程", 503);
          });
        } catch { finish("无法联系组网服务进程", 503); }
      });
    },
    close() {
      parent.off("message", receive);
      parent.off("disconnect", disconnect);
      disconnect();
    },
  };
}

export function createMeshGateway({ dataDir, env = process.env, request = fetch, serviceId, audit = () => {}, service, runtime, authenticateDesktop = () => false }) {
  const mesh = service ?? createMeshService({ dataDir, env, request, serviceId });
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function mintForPhone(name) {
    if (!mesh.configured) throw httpError(503, "该电脑尚未配置组网控制面");
    const state = await mesh.status();
    if (state.phase !== "joined" || !state.dnsName) throw httpError(409, "请先让电脑加入组网");
    const issued = await mesh.mintNodeKey({ nodeName: name });
    return { ...issued, accessUrl: `http://${state.dnsName}` };
  }

  async function handleAdmin(req, res, action) {
    if (!authenticateDesktop(req) || !LOOPBACK.has(req.socket?.remoteAddress) ||
        Object.keys(req.headers).some(name => /^(forwarded$|x-forwarded-|x-real-ip$|cf-)/i.test(name))) {
      throw httpError(403, "该操作需要本机桌面授权");
    }
    if (action === "nodes" && req.method === "GET") {
      json(res, 200, { nodes: await mesh.listNodes() });
      return;
    }
    if (req.method !== "POST") throw httpError(405, "Method not allowed");
    const body = await readJson(req);
    switch (action) {
      case "key": {
        if (body.device !== "desktop" && body.device !== "phone") throw httpError(400, "无效设备类型");
        const name = nodeName(body.nodeName, body.device);
        const issued = body.device === "phone" ? await mintForPhone(name) : await mesh.mintNodeKey({ nodeName: name });
        audit("mesh.key", "desktop", "success");
        json(res, 200, issued);
        return;
      }
      case "onboard":
      case "offboard":
        if (!runtime) throw httpError(503, "组网服务未运行");
        await runtime.run(action, nodeName(body.nodeName));
        break;
      case "report":
        if (typeof body.tailnetIPv4 !== "string" || !isIPv4(body.tailnetIPv4) || !/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(?:\.\d{1,3}){2}$/.test(body.tailnetIPv4)) {
          throw httpError(400, "无效的组网 IPv4 地址");
        }
        if (typeof body.dnsName !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9]+$/i.test(body.dnsName)) {
          throw httpError(400, "无效的 MagicDNS 地址");
        }
        await mesh.markJoined({ hostname: nodeName(body.hostname, "desktop"), tailnetIPv4: body.tailnetIPv4,
          dnsName: body.dnsName });
        break;
      case "error":
        await mesh.markError(typeof body.message === "string" ? body.message : "组网失败");
        break;
      case "left": {
        const state = await mesh.status();
        if (state.tailnetIPv4) await mesh.removeDesktopNode(state.tailnetIPv4);
        await mesh.markOffboarded();
        break;
      }
      default:
        throw httpError(404, "Unknown mesh admin action");
    }
    json(res, 200, await mesh.status());
  }

  return {
    service: mesh,
    async handle(req, res) {
      const path = new URL(req.url || "/", "http://gateway.local").pathname;
      if (!path.startsWith("/api/mesh/")) return false;
      try {
        const deviceId = req.headers["x-agentroam-device-id"];
        if (path === "/api/mesh/status") {
          if (req.method !== "GET") throw httpError(405, "Method not allowed");
          if (!deviceId && !authenticateDesktop(req)) throw httpError(401, "请先完成设备配对");
          json(res, 200, await mesh.status());
        } else if (path === "/api/mesh/join") {
          if (req.method !== "POST") throw httpError(405, "Method not allowed");
          if (!deviceId) throw httpError(401, "请先完成设备配对");
          const body = await readJson(req);
          const issued = await mintForPhone(nodeName(body.nodeName, "phone"));
          audit("mesh.join", String(deviceId), "success");
          json(res, 200, issued);
        } else if (path.startsWith("/api/mesh/admin/")) {
          await handleAdmin(req, res, path.slice("/api/mesh/admin/".length));
        } else {
          throw httpError(404, "Not found");
        }
      } catch (error) {
        if (error instanceof HeadscaleHttpError) {
          json(res, 502, { error: `Headscale 请求失败（HTTP ${error.status}）` });
          return true;
        }
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status
          : [502, 503, 504].includes(error?.status) ? error.status : 502;
        json(res, status, { error: status === 502 && !error.status ? "组网控制面请求失败，请检查服务日志和配置" : error.message });
      }
      return true;
    },
  };
}
