export interface MobilePairingInvitation {
    svg: string;
    origin: string;
    pairingUrl: string;
    expiresAt: number;
}
export declare function pairingOrigin(raw: string): string;
export declare function readMobilePairingOrigin(dataDir: string): Promise<string>;
/** Invitation generation stays in main; the renderer never receives the local admin token. */
export declare function createMobilePairingInvitation(dataDir: string, request: () => Promise<{
    status: number;
    body: string;
}>, accessUrl?: string): Promise<MobilePairingInvitation>;
//# sourceMappingURL=mobile-pairing.d.ts.map