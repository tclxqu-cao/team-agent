import type { ChildProcess } from "node:child_process";
import { isIPv4 } from "node:net";
import type { PlatformTarget } from "../platform.js";
import { localServiceRequest } from "../local-service-request.js";
import { TailscaleDaemon } from "../tailscale/daemon-manager.js";
import { ensureTailscaleBinaries } from "../tailscale/installer.js";
import { readTailscaleStatus, tailscaleLogout, tailscaleServe, tailscaleServeReset, tailscaleUp } from "../tailscale/tailnet-cli.js";
import { meshMachineId } from "./mesh-payload.js";

interface MeshRuntimeOptions {
  dataDir: string;
  localUrl: string;
  target: PlatformTarget;
  log?: (message: string) => void;
}
type MeshAction = "onboard" | "offboard";
type MeshState = { configured: boolean; phase: string; controlPlaneUrl: string | null };

export function createMeshRuntime({ dataDir, localUrl, target, log }: MeshRuntimeOptions) {
  const controller = new AbortController();
  const { signal } = controller;
  let daemon: TailscaleDaemon | undefined;
  let pending = Promise.resolve();
  const request = <T>(action: string, body?: unknown) =>
    localServiceRequest<T>(dataDir, `/api/mesh/${action}`, body === undefined
      ? { signal } : { signal, method: "POST", body, timeoutMs: 60_000 });

  async function apply(action: MeshAction, requestedName?: string, automatic = false) {
    signal.throwIfAborted();
    const state = await request<MeshState>("status");
    if (!state.configured) {
      if (automatic) return;
      throw new Error("请先配置 Headscale 控制面和 API key，再重启 AgentRoam");
    }
    if (automatic && state.phase === "offboarded") return;
    if (action === "offboard" && state.phase === "offboarded") return;

    try {
      const binaries = await ensureTailscaleBinaries(target, dataDir);
      signal.throwIfAborted();
      daemon ??= new TailscaleDaemon({ dataDir, tailscaledPath: binaries.tailscaled, signal, onLog: log });
      const cli = { tailscalePath: binaries.tailscale, socketPath: daemon.socketPath(), signal };
      const runtime = await daemon.ensureRunning(binaries.tailscale);
      const isRunning = runtime.status.backendState === "Running";
      if (isRunning && runtime.status.controlPlaneUrl !== state.controlPlaneUrl) {
        throw new Error("已加入的控制面与当前配置不同，请先恢复原配置并退出组网");
      }
      if (action === "offboard") {
        try {
          await tailscaleServeReset(cli);
          if (isRunning) await tailscaleLogout(cli);
          await request("admin/left", {});
        } finally { await daemon.stop(); }
        return;
      }

      const name = requestedName ?? meshMachineId(runtime.status.hostname ?? undefined);
      if (!isRunning) {
        const issued = await request<{ loginServer: string; authkey: string }>("admin/key", { device: "desktop", nodeName: name });
        await tailscaleUp(cli, { loginServer: issued.loginServer, authKey: issued.authkey, hostname: name, stateDir: runtime.stateDir });
      }
      const status = await readTailscaleStatus(cli);
      const tailnetIPv4 = status.tailscaleIPs.find(ip => {
        if (!isIPv4(ip)) return false;
        const [network, subnet] = ip.split(".").map(Number);
        return network === 100 && subnet >= 64 && subnet <= 127;
      });
      if (status.backendState !== "Running" || !tailnetIPv4) throw new Error("入网未完成，未获得组网 IPv4 地址");
      if (!status.dnsName) throw new Error("Headscale 未提供 MagicDNS 地址，请检查控制面配置");
      await tailscaleServe(cli, localUrl);
      await request("admin/report", { hostname: status.hostname ? meshMachineId(status.hostname) : name, tailnetIPv4, dnsName: status.dnsName });
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        await request("admin/error", { message }).catch(() => {});
      }
      throw error;
    }
  }

  return {
    run(action: MeshAction, name?: string, automatic = false) {
      const operation = pending.then(() => apply(action, name, automatic));
      pending = operation.catch(() => {});
      return operation;
    },
    async close() {
      controller.abort();
      await daemon?.stop();
      await pending;
    },
  };
}

export function attachMeshControl(child: ChildProcess, runtime: ReturnType<typeof createMeshRuntime>): () => void {
  const receive = (message: { type?: string; id?: string; action?: MeshAction; name?: string }) => {
    if (message?.type !== "agentroam:mesh-run" || typeof message.id !== "string" ||
        (message.action !== "onboard" && message.action !== "offboard")) return;
    const reply = (error?: string) => {
      if (child.connected) child.send({ type: "agentroam:mesh-result", id: message.id, error }, () => {});
    };
    void runtime.run(message.action, message.name).then(() => reply(), error => reply(error instanceof Error ? error.message : String(error)));
  };
  child.on("message", receive);
  return () => child.off("message", receive);
}
