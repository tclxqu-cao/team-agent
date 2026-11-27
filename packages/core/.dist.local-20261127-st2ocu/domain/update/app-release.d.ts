import { type UpdateAsset, type UpdatePlatform } from "./update-release.js";
export type DesktopEdition = "desktop" | "desktop-lite";
export type AppUpdateTarget = {
    client: DesktopEdition;
    platform: UpdatePlatform;
} | {
    client: "android";
    platform: "android";
};
interface AppRelease {
    version: string;
    asset: UpdateAsset;
}
export declare function readAppRelease(target: AppUpdateTarget, currentVersion: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<AppRelease | null>;
export {};
//# sourceMappingURL=app-release.d.ts.map