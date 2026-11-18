import { describe, expect, it } from "vitest";
import { supportsWebTaskSplit } from "./webTaskSplit";

const desktop = { width: 1440, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36", coarsePointer: false, nativeApp: false };

describe("desktop browser split workspace eligibility", () => {
  it("allows wide desktop browsers on macOS, Windows and Linux", () => {
    for (const userAgent of [desktop.userAgent, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0", "Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0"]) {
      expect(supportsWebTaskSplit({ ...desktop, userAgent })).toBe(true);
    }
    expect(supportsWebTaskSplit({ ...desktop, width: 900 })).toBe(true);
  });

  it("keeps phones off even when landscape or desktop-mode viewports are wide", () => {
    for (const userAgent of ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148", "Mozilla/5.0 (Linux; Android 14; Pixel 9) Chrome/131.0 Mobile Safari/537.36", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1"]) {
      expect(supportsWebTaskSplit({ ...desktop, width: 1024, userAgent })).toBe(false);
    }
  });

  it("rejects narrow viewports, touch-primary desktop agents and native mobile shells", () => {
    expect(supportsWebTaskSplit({ ...desktop, width: 899 })).toBe(false);
    expect(supportsWebTaskSplit({ ...desktop, coarsePointer: true })).toBe(false);
    expect(supportsWebTaskSplit({ ...desktop, nativeApp: true })).toBe(false);
    expect(supportsWebTaskSplit({ ...desktop, width: NaN })).toBe(false);
  });
});
