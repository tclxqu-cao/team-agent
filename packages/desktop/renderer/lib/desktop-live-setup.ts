import type { DesktopLiveStatus } from "../global";

export interface DesktopLiveSetupInfo {
  supported: boolean;
  needsSetup: boolean;
  status: DesktopLiveStatus;
}

/**
 * Remote authorization still needs user action: the switch was never set up
 * (nothing persisted, e.g. the user dismissed the startup dialog), or sharing
 * is enabled while system permissions (screen recording / accessibility) are
 * missing. A deliberate disable after completed setup is not "pending".
 */
export function isDesktopLiveSetupPending(info: DesktopLiveSetupInfo): boolean {
  if (!info.supported) return false;
  return info.needsSetup
    || (info.status.enabled && (info.status.permissionScreen !== "granted" || info.status.accessibilityTrusted !== true));
}
