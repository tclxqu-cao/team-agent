import type { MobilePairingInvitation } from "../../main/mobile-pairing";
import type { RuntimeBootstrapStatus } from "../../main/runtime-bootstrap";
import type { DesktopLiveCliStatus } from "../../main/desktop-live-cli-proxy";
import type { PairingRoute, TunnelStatus } from "../../../shared/src/contracts/tunnel-status";

export interface LiteApi {
  refresh(route?: string): Promise<MobilePairingInvitation>;
  pairingRoutes(): Promise<PairingRoute[]>;
  progress(): Promise<RuntimeBootstrapStatus>;
  tunnelStatus(): Promise<TunnelStatus>;
  connectTunnel(): Promise<TunnelStatus>;
  authorization(action: "status" | "enable" | "recheck" | "restart" | "authorize", permission?: "screen" | "accessibility"): Promise<DesktopLiveCliStatus>;
}
declare global { interface Window { liteApi: LiteApi } }
