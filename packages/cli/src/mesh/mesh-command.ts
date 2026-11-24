import { renderQr } from "../qr.js";
import { localServiceRequest } from "../local-service-request.js";
import { meshQrPayload } from "./mesh-payload.js";

export { meshQrPayload };

export type MeshAction = "status" | "onboard" | "offboard" | "qr" | "nodes";

export interface MeshCommandOptions {
  action: MeshAction;
  dataDir: string;
  nodeName?: string;
  qr?: boolean;
}

export async function runMeshCommand(options: MeshCommandOptions): Promise<void> {
  if (options.action === "status") return printStatus(options);
  if (options.action === "nodes") return printNodes(options);
  if (options.action === "qr") return printJoinQr(options);
  await localServiceRequest(options.dataDir, `/api/mesh/admin/${options.action}`, {
    method: "POST", body: { nodeName: options.nodeName }, timeoutMs: 125_000,
  });
  await printStatus(options);
}

async function printStatus(options: MeshCommandOptions): Promise<void> {
  const status = await localServiceRequest<{
    configured: boolean; controlPlaneUrl: string | null; phase: string;
    hostname: string | null; tailnetIPv4: string | null; dnsName: string | null;
    user: string | null; joinedAt: string | null; lastError: string | null;
  }>(options.dataDir, "/api/mesh/status");
  console.log(`控制面：${status.configured ? status.controlPlaneUrl : "未配置（使用一次性激活码启动，或配置自管 Headscale 后重启服务）"}`);
  console.log(`状态：${status.phase}${status.lastError ? `（${status.lastError}）` : ""}`);
  if (status.hostname) console.log(`设备：${status.hostname}`);
  if (status.tailnetIPv4) console.log(`Tailnet IP：${status.tailnetIPv4}`);
  if (status.phase === "joined" && status.dnsName) console.log(`网关地址：http://${status.dnsName}`);
  if (status.user) console.log(`Headscale 用户：${status.user}`);
  if (status.joinedAt) console.log(`入网时间：${new Date(status.joinedAt).toLocaleString()}`);
}

async function printNodes(options: MeshCommandOptions): Promise<void> {
  const { nodes } = await localServiceRequest<{ nodes: { id: string; name: string; user: string | null }[] }>(
    options.dataDir, "/api/mesh/admin/nodes",
  );
  console.log(nodes.length
    ? nodes.map((node) => `${node.id}  ${node.name}  ${node.user ?? "-"}`).join("\n")
    : "控制面上暂无节点");
}

async function printJoinQr(options: MeshCommandOptions): Promise<void> {
  const issued = await localServiceRequest<{ loginServer: string; authkey: string; expiresAt: string | null; accessUrl: string }>(
    options.dataDir, "/api/mesh/admin/key", {
      method: "POST",
      body: { device: "phone", nodeName: options.nodeName }, timeoutMs: 60_000,
    },
  );
  const payload = meshQrPayload(issued);
  console.log("手机加入组网（一次性，15 分钟内有效；请勿截图分享）：");
  if (options.qr !== false && process.stdout.isTTY) console.log(await renderQr(payload));
  console.log(`\n控制面地址：${issued.loginServer}`);
  console.log(`认证 key：${issued.authkey}`);
  console.log("在 Tailscale 客户端选择自定义控制面，使用以上认证 key 注册设备。");
  console.log(`入网后生成 AgentRoam App 授权码：agentroam pair`);
}
