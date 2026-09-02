import { describe, expect, it } from "vitest";
import { getDefaultWakeEnabled } from "./uiStore";

describe("wake listening defaults", () => {
  it("keeps wake listening enabled for the desktop renderer", () => {
    expect(getDefaultWakeEnabled(false)).toBe(true);
  });

  it("starts the web shell with wake listening disabled", () => {
    expect(getDefaultWakeEnabled(true)).toBe(false);
  });
});
