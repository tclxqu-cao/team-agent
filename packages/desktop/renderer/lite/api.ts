import type { MobilePairingInvitation } from "../../main/mobile-pairing";
import type { RuntimeBootstrapStatus } from "../../main/runtime-bootstrap";
import type { DesktopLiveCliStatus } from "../../main/desktop-live-cli-proxy";

export interface LiteApi {
  refresh(): Promise<MobilePairingInvitation>;
  progress(): Promise<RuntimeBootstrapStatus>;
  authorization(action: "status" | "enable" | "recheck" | "restart" | "authorize", permission?: "screen" | "accessibility"): Promise<DesktopLiveCliStatus>;
}
declare global { interface Window { liteApi: LiteApi } }
