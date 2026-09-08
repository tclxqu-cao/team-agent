import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("UpdateNotice source contract", () => {
  const source = readFileSync(resolve(__dirname, "UpdateNotice.tsx"), "utf8");
  it("checks cached state before the background refresh", () => {
    expect(source.indexOf("getUpdateStatus()")).toBeLessThan(source.indexOf("checkForUpdate()"));
    expect(source).toContain("FIRST_CHECK_MIN_MS = 6_000");
    expect(source).toContain("FIRST_CHECK_JITTER_MS = 24_000");
    expect(source).toContain("window.setTimeout");
  });
  it("downloads only from the explicit action", () => {
    expect(source.match(/installUpdate\(\)/g)).toHaveLength(1);
    expect(source).toContain("onClick={() => void install()}");
  });
  it("keeps dismissal scoped to the target version", () => {
    expect(source).toContain('sessionStorage.setItem("agentroam.dismissed-update", status.targetVersion)');
  });
});
