import type { RuntimeBootstrapStatus } from "./runtime-bootstrap.js";
import type { SharedServiceConnection } from "./shared-service.js";
import { readMobilePairingOrigin, type MobilePairingInvitation } from "./mobile-pairing.js";
/** Reuse a phone-ready CLI service; a local development server must not block first-run setup. */
export declare class LitePairingService {
    private readonly service;
    private readonly bootstrap;
    private readonly readOrigin;
    private readonly prepareSharing;
    private pending;
    constructor(service: Pick<SharedServiceConnection, "status" | "select" | "mobilePairing">, bootstrap: {
        prepare(): Promise<RuntimeBootstrapStatus>;
    }, readOrigin?: typeof readMobilePairingOrigin, prepareSharing?: () => Promise<void>);
    refresh(): Promise<MobilePairingInvitation>;
    private connect;
    private prepare;
}
//# sourceMappingURL=lite-pairing.d.ts.map