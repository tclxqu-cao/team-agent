import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("UpdateNotice source contract", () => {
  const source = readFileSync(resolve(__dirname, "UpdateNotice.tsx"), "utf8");
  it("reads and subscribes to background status and reserves a fresh check for the button", () => {
    expect(source).toContain("api.getUpdateStatus()");
    expect(source).toContain("api.onUpdateStatus?.(");
    expect(source.match(/api\.checkForUpdate\(\)/g)).toHaveLength(1);
    expect(source).toContain("onClick={update.check}");
    expect(source).toContain("showModal()");
  });
  it("downloads only from the explicit action", () => {
    expect(source.match(/installUpdate\(\)/g)).toHaveLength(1);
    expect(source).toContain("onClick={() => void install()}");
  });
  it("keeps dismissal scoped to the target version", () => {
    expect(source).toContain('`agentroam.dismissed-update.${scope}`');
    expect(source).toContain("sessionStorage.setItem(storageKey, version)");
    expect(source).toContain("status.targetVersion !== dismissedVersion");
    expect(source).toContain("setDismissedVersion(null)");
  });
  it("uses update availability for button color independently of dialog dismissal", () => {
    expect(source).toContain("const Icon = update.checking ? LoaderCircle : Download");
    expect(source).toContain("data-update-available={update.available || undefined}");
    expect(source).toContain("Boolean(status?.targetVersion && AVAILABLE_PHASES.has(status.phase))");
    expect(readFileSync(resolve(__dirname, "UpdateNotice.css"), "utf8")).toContain(".update-check-button[data-update-available]");
  });
});
