import { describe, expect, it } from "vitest";
import { isDesktopLiveSetupPending } from "./desktop-live-setup";
import type { DesktopLiveStatus } from "../global";

const granted: DesktopLiveStatus = {
  enabled: true,
  permissionScreen: "granted",
  accessibilityTrusted: true,
  sessionOnline: true,
  controlState: null,
};

const baseInfo = { supported: true, needsSetup: false, status: granted };

describe("isDesktopLiveSetupPending", () => {
  it("is pending when setup was never completed (nothing persisted)", () => {
    expect(isDesktopLiveSetupPending({ ...baseInfo, needsSetup: true, status: { ...granted, enabled: false } })).toBe(true);
  });

  it("is pending when sharing is enabled but screen permission is missing", () => {
    expect(isDesktopLiveSetupPending({
      ...baseInfo,
      status: { ...granted, permissionScreen: "not-determined" },
    })).toBe(true);
  });

  it("is pending when sharing is enabled but accessibility is unverified", () => {
    expect(isDesktopLiveSetupPending({
      ...baseInfo,
      status: { ...granted, accessibilityTrusted: false },
    })).toBe(true);
    expect(isDesktopLiveSetupPending({
      ...baseInfo,
      status: { ...granted, accessibilityTrusted: null },
    })).toBe(true);
  });

  it("is not pending once setup completed, even when sharing is off", () => {
    expect(isDesktopLiveSetupPending({ ...baseInfo, status: { ...granted, enabled: false } })).toBe(false);
  });

  it("is not pending when everything is granted and online", () => {
    expect(isDesktopLiveSetupPending(baseInfo)).toBe(false);
  });

  it("is not pending on unsupported platforms", () => {
    expect(isDesktopLiveSetupPending({ ...baseInfo, supported: false, needsSetup: true })).toBe(false);
  });
});
