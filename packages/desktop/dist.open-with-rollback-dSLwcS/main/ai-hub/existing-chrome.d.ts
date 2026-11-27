import { execFile } from "node:child_process";
/** LaunchServices reuses the ordinary Chrome instance/profile. Never add debugging or profile flags. */
export declare function openExistingChrome(url: string, run?: typeof execFile.__promisify__): Promise<void>;
/** Fixed internal page, separate from the HTTPS-only site navigation entry. */
export declare function openChromeExtensions(run?: typeof execFile.__promisify__): Promise<void>;
//# sourceMappingURL=existing-chrome.d.ts.map