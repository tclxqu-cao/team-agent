import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { PairingRoute, TunnelStatus } from "../../../shared/src/contracts/tunnel-status.js";
import { pairingNetworkRoutes } from "../network.js";
import { waitForPublicReadiness } from "./public-readiness.js";
import { resolveRelayProvider, selectRelay, type RelayOrchestratorOptions, type RelaySelection } from "./relay-orchestrator.js";
import { readDefaultRelayUrl } from "./self-hosted-provider.js";

type PairingRelay = "self-hosted" | "cloudflare";

/** Owns only the public route. Server, agents and terminals have a separate lifetime. */
export class TunnelController {
  private readonly abort = new AbortController();
  private selection: RelaySelection | null = null;
  private pairingRelays = new Map<PairingRelay, Promise<RelaySelection>>();
  private pending: Promise<TunnelStatus> | null = null;
  private stopped = false;
  private observers = new Set<(status: TunnelStatus) => void>();
  private state: TunnelStatus;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    relay: Omit<RelayOrchestratorOptions, "signal" | "lanUrl" | "onStage">;
    lanUrl: () => Promise<string>;
    publish: (status: TunnelStatus) => Promise<void>;
    select?: typeof selectRelay;
    networkRoutes?: () => PairingRoute[];
    checkNetworkRoute?: typeof waitForPublicReadiness;
    onError?: (error: unknown) => void;
  }) {
    this.state = { phase: "idle", mode: "local", provider: "lan", accessUrl: `${options.relay.localUrl}/web` };
    if (options.relay.cli.testNoPairing) this.state = { ...this.state, phase: "unsupported", error: "测试模式不支持公网连接，请以正常配对模式启动服务。" };
  }
  status(): TunnelStatus { return { ...this.state }; }

  pairingRoutes(): PairingRoute[] {
    if (this.stopped) return [];
    const choices: PairingRoute[] = [];
    if (this.state.phase !== "unsupported") {
      if (this.options.relay.cli.relayUrl || readDefaultRelayUrl()) choices.push({ id: "self-hosted", kind: "self-hosted" });
      choices.push({ id: "cloudflare", kind: "cloudflare" });
    }
    return choices.concat((this.options.networkRoutes ?? pairingNetworkRoutes)());
  }

  async pairingUrl(via: string): Promise<string> {
    if (this.stopped) throw new Error("当前后台已停止，无法切换配对线路。");
    if (via === "self-hosted" || via === "cloudflare") {
      if (this.state.phase === "unsupported") throw new Error("当前后台不支持公网配对线路。");
      return this.publicPairingUrl(via);
    }
    const choices = (this.options.networkRoutes ?? pairingNetworkRoutes)();
    const routedAddress = via === "lan" ? new URL(await this.currentLocalUrl()).hostname : undefined;
    const route = via === "lan"
      ? choices.find(choice => choice.kind === "lan" && choice.address === routedAddress) ?? choices.find(choice => choice.kind === "lan")
      : via === "tailscale"
        ? choices.find(choice => choice.kind === "tailscale")
        : via === "vpn"
          ? selectSingleNetworkRoute(choices, "vpn")
          : choices.find(choice => choice.id === via);
    if (!route?.address) throw new Error("所选网络地址当前不可用，请刷新连接选项。");
    const origin = `http://${route.address}:${this.options.relay.port}`;
    try {
      await (this.options.checkNetworkRoute ?? waitForPublicReadiness)(origin, {
        timeoutMs: 3000, proxyResolver: async () => null, signal: this.abort.signal,
        fetchImpl: (url, init) => fetch(url, { ...init, redirect: "error" }),
      });
    } catch { throw new Error("无法通过所选 IP 访问本机服务，请检查网络和防火墙。"); }
    return `${origin}/web`;
  }

  private async publicPairingUrl(via: PairingRelay): Promise<string> {
    if (via === "self-hosted" && !this.options.relay.cli.relayUrl && !readDefaultRelayUrl()) throw new Error("自建 HTTPS 入口地址未配置。");
    if (resolveRelayProvider(this.options.relay.cli) === via) {
      const status = await this.connect();
      if (status.provider === via && status.phase === "ready" && status.accessUrl) return status.accessUrl;
      throw new Error(status.error || "所选公网线路未连接，请重试。");
    }
    let pending = this.pairingRelays.get(via);
    if (!pending) {
      const start = (this.options.select ?? selectRelay)({
        ...this.options.relay, signal: this.abort.signal, lanUrl: this.options.relay.localUrl,
        cli: { ...this.options.relay.cli, relay: via, localOnly: false }, onAttempt: undefined, onFailure: undefined,
      });
      const clear = () => { if (this.pairingRelays.get(via) === pending) this.pairingRelays.delete(via); };
      pending = start.then(result => {
        if (!result.tunnel) throw new Error(`${via === "cloudflare" ? "Cloudflare" : "自建 HTTPS"} 未连接，请检查电脑网络后重试。`);
        void result.tunnel.exited.then(clear, clear);
        return result;
      }).catch(error => { clear(); throw error; });
      this.pairingRelays.set(via, pending);
    }
    return `${(await pending).publicUrl}/web`;
  }
  subscribe(listener: (status: TunnelStatus) => void): () => void {
    this.observers.add(listener); listener(this.status());
    return () => this.observers.delete(listener);
  }
  connect(forcePublic = true): Promise<TunnelStatus> {
    if (this.pending) return this.pending;
    if (this.stopped || this.state.phase === "ready" || this.state.phase === "unsupported") return Promise.resolve(this.status());
    this.set({ ...this.state, phase: "connecting", stage: "connecting", error: undefined });
    this.pending = this.attempt(forcePublic).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async attempt(forcePublic: boolean): Promise<TunnelStatus> {
    let lanUrl = this.options.relay.localUrl;
    try {
      lanUrl = await this.options.lanUrl();
      if (this.stopped) return this.status();
      this.set({ ...this.fallback(lanUrl), phase: "connecting", stage: "connecting" });
      await this.persist();
      const result = await (this.options.select ?? selectRelay)({
        ...this.options.relay, lanUrl, signal: this.abort.signal,
        cli: { ...this.options.relay.cli, localOnly: forcePublic ? false : this.options.relay.cli.localOnly },
        onStage: stage => this.set({ ...this.state, stage }),
      });
      if (this.stopped) { await result.tunnel?.close(); return this.status(); }
      this.selection = result;
      const error = result.failures.length ? this.failureMessage() : undefined;
      if (!result.tunnel) lanUrl = await this.currentLocalUrl();
      if (this.stopped) return this.status();
      await this.commit(result.tunnel
        ? { phase: "ready", mode: "public", provider: result.provider, accessUrl: `${result.publicUrl}/web` }
        : { ...this.fallback(lanUrl), phase: error ? "error" : "idle", error });
      if (result.tunnel) void result.tunnel.exited.then(() => this.disconnected(result)).catch(error => this.report(error));
    } catch (error) {
      if (!this.stopped) {
        this.report(error);
        const current = this.selection; this.selection = null;
        await current?.tunnel?.close().catch(error => this.report(error));
        lanUrl = await this.currentLocalUrl();
        if (this.stopped) return this.status();
        this.set({ ...this.fallback(lanUrl), phase: "error", error: "公网连接未完成，请检查电脑网络或代理后重试。" });
        await this.persist();
      }
    }
    return this.status();
  }
  private failureMessage(): string {
    return this.state.stage === "checking"
      ? "公网地址可达性检查未通过，请检查电脑网络或代理后重试。"
      : "公网隧道连接失败或超时，请检查电脑网络后重试。";
  }
  private fallback(url: string): TunnelStatus {
    return { phase: "idle", mode: url === this.options.relay.localUrl ? "local" : "lan", provider: "lan", accessUrl: `${url}/web` };
  }
  private currentLocalUrl(): Promise<string> {
    return this.options.lanUrl().catch(() => this.options.relay.localUrl);
  }
  private async disconnected(selection: RelaySelection): Promise<void> {
    if (this.stopped || this.selection !== selection) return;
    this.selection = null;
    const url = await this.currentLocalUrl();
    if (this.stopped) return;
    await this.commit({ ...this.fallback(url), phase: "error", error: "公网连接已断开，请重试连接。" });
    if (selection.provider !== "self-hosted") return;
    for (const wait of [1000, 2000, 5000]) {
      await delay(wait, undefined, { signal: this.abort.signal }).catch(() => {});
      if (this.stopped || this.state.phase === "ready") return;
      if ((await this.connect()).phase === "ready") return;
    }
  }
  private set(status: TunnelStatus): void {
    this.state = status;
    for (const observer of this.observers) observer(this.status());
  }
  private persist(): Promise<void> {
    const status = this.status();
    const write = this.writes.then(() => this.options.publish(status));
    this.writes = write.catch(error => this.report(error));
    return write;
  }
  private async commit(status: TunnelStatus): Promise<void> {
    const previous = this.state;
    this.state = status;
    try { await this.persist(); }
    catch (error) { this.state = previous; throw error; }
    if (!this.stopped) for (const observer of this.observers) observer(this.status());
  }
  private report(error: unknown) { this.options.onError?.(error); }
  async close(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.pending;
    await this.selection?.tunnel?.close().catch(error => this.report(error));
    this.selection = null;
    await Promise.allSettled([...this.pairingRelays.values()].map(async relay => (await relay).tunnel?.close()));
    this.pairingRelays.clear();
    await this.writes;
    this.observers.clear();
  }
}

function selectSingleNetworkRoute(routes: PairingRoute[], kind: PairingRoute["kind"]): PairingRoute | undefined {
  const matches = routes.filter(route => route.kind === kind);
  if (matches.length > 1) {
    throw new Error(`检测到多个${kind === "vpn" ? "自建 VPN" : "网络"}地址，请改用具体 IPv4。`);
  }
  return matches[0];
}

export function attachTunnelControl(child: ChildProcess, controller: TunnelController): () => void {
  const unsubscribe = controller.subscribe(status => {
    if (child.connected) child.send({ type: "agentroam:tunnel-status", status }, () => {});
  });
  const receive = (message: unknown) => {
    if ((message as { type?: string })?.type === "agentroam:tunnel-connect") void controller.connect().catch(() => {});
    const request = message as { type?: string; id?: string; route?: string } | null;
    if (request?.type !== "agentroam:pairing-route" || typeof request.id !== "string") return;
    const id = request.id;
    const reply = (result: unknown, error?: string) => {
      if (child.connected) child.send({ type: "agentroam:pairing-route-result", id, result, error }, () => {});
    };
    const work = request.route === undefined
      ? Promise.resolve().then(() => ({ routes: controller.pairingRoutes() }))
      : controller.pairingUrl(request.route).then(accessUrl => ({ accessUrl }));
    void work.then(
      result => reply(result), error => reply(undefined, error instanceof Error ? error.message : "无法准备所选线路。"),
    );
  };
  child.on("message", receive);
  return () => { unsubscribe(); child.removeListener("message", receive); };
}
