import type { ChildProcess } from "node:child_process";
import type { TunnelStatus } from "../../../server/lib/tunnel-control.mjs";
import { selectRelay, type RelayOrchestratorOptions, type RelaySelection } from "./relay-orchestrator.js";

/** Owns only the public route. Server, agents and terminals have a separate lifetime. */
export class TunnelController {
  private readonly abort = new AbortController();
  private selection: RelaySelection | null = null;
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
    onError?: (error: unknown) => void;
  }) {
    this.state = { phase: "idle", mode: "local", provider: "lan", accessUrl: `${options.relay.localUrl}/web` };
    if (options.relay.cli.testNoPairing) this.state = { ...this.state, phase: "unsupported", error: "测试模式不支持公网连接，请以正常配对模式启动服务。" };
  }
  status(): TunnelStatus { return { ...this.state }; }
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
    await this.writes;
    this.observers.clear();
  }
}

export function attachTunnelControl(child: ChildProcess, controller: TunnelController): () => void {
  const unsubscribe = controller.subscribe(status => {
    if (child.connected) child.send({ type: "agentroam:tunnel-status", status }, () => {});
  });
  const receive = (message: unknown) => {
    if ((message as { type?: string })?.type === "agentroam:tunnel-connect") void controller.connect().catch(() => {});
  };
  child.on("message", receive);
  return () => { unsubscribe(); child.removeListener("message", receive); };
}
