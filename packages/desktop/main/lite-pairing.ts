import type { RuntimeBootstrapStatus } from "./runtime-bootstrap.js";
import type { SharedServiceConnection } from "./shared-service.js";
import { readMobilePairingOrigin, type MobilePairingInvitation } from "./mobile-pairing.js";

/** Reuse a phone-ready CLI service; a local development server must not block first-run setup. */
export class LitePairingService {
  private pending: Promise<MobilePairingInvitation> | null = null;
  private pendingRoute?: string;
  constructor(
    private readonly service: Pick<SharedServiceConnection, "status" | "select" | "mobilePairing" | "meshPairingOrigin">,
    private readonly bootstrap: { prepare(): Promise<RuntimeBootstrapStatus> },
    private readonly readOrigin = readMobilePairingOrigin,
    private readonly prepareSharing: () => Promise<void> = async () => {},
  ) {}

  refresh(route?: string): Promise<MobilePairingInvitation> {
    if (this.pending && this.pendingRoute === route) return this.pending;
    const work = this.pending ? this.pending.catch(() => null).then(() => this.prepare(route)) : this.prepare(route);
    const pending = work.finally(() => { if (this.pending === pending) this.pending = null; });
    this.pendingRoute = route;
    this.pending = pending;
    return pending;
  }

  private async connect(): Promise<boolean> {
    const status = await this.service.status();
    const choices = [...status.choices].sort((a, b) => Number(b.instanceId === status.selected?.instanceId) - Number(a.instanceId === status.selected?.instanceId));
    for (const choice of choices) {
      try { if (!await this.service.meshPairingOrigin(choice.instanceId)) await this.readOrigin(choice.dataDir); }
      catch { continue; }
      if (choice.instanceId !== status.selected?.instanceId) await this.service.select(choice.instanceId);
      return true;
    }
    return false;
  }

  private async prepare(route?: string): Promise<MobilePairingInvitation> {
    if (!await this.connect()) {
      const result = await this.bootstrap.prepare();
      if (result.phase !== "ready") throw new Error(result.message || "运行环境尚未就绪，请点击刷新重试。");
      if (!await this.connect()) throw new Error("手机访问连接尚未就绪，请稍后点击刷新重试。");
    }
    // Authorization errors (including emergency lock) must remain visible, never switch services to bypass them.
    const invitation = await this.service.mobilePairing(route);
    await this.prepareSharing();
    return invitation;
  }
}
