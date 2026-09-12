import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDesktopLiveState, readDesktopLiveState, writeDesktopLiveState } from "./desktop-live-state";

describe("desktop-live-state", () => {
  it("defaults to disabled for missing, malformed, or non-object files", async () => {
    expect(normalizeDesktopLiveState(undefined)).toEqual({ enabled: false, displayId: null });
    expect(normalizeDesktopLiveState("nope")).toEqual({ enabled: false, displayId: null });
    expect(normalizeDesktopLiveState({ enabled: "yes" })).toEqual({ enabled: false, displayId: null });
    const dir = await mkdtemp(join(tmpdir(), "desktop-live-"));
    try {
      const path = join(dir, "desktop-live.json");
      expect(await readDesktopLiveState(path)).toEqual({ enabled: false, displayId: null });
      const broken = join(dir, "broken.json");
      await writeFile(broken, "{not json", "utf8");
      expect(await readDesktopLiveState(broken)).toEqual({ enabled: false, displayId: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the enabled flag and display choice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-live-"));
    try {
      const path = join(dir, "desktop-live.json");
      await writeDesktopLiveState(path, { enabled: true, displayId: null });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: true, displayId: null });
      expect(await readDesktopLiveState(path)).toEqual({ enabled: true, displayId: null });
      await writeDesktopLiveState(path, { enabled: true, displayId: "123" });
      expect(await readDesktopLiveState(path)).toEqual({ enabled: true, displayId: "123" });
      // Legacy files without a display choice normalize to the primary display.
      await writeFile(path, JSON.stringify({ enabled: true }), "utf8");
      expect(await readDesktopLiveState(path)).toEqual({ enabled: true, displayId: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
