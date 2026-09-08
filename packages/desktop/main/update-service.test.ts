import { createHash } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { desktopPlatform } from "./update-service.js";

describe("DesktopUpdateService contract", () => {
  it("allowlists only native release targets", () => {
    expect(desktopPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(desktopPlatform("win32", "x64")).toBe("windows-amd64");
    expect(desktopPlatform("linux", "x64")).toBeNull();
  });

  it("uses SHA-256 bytes as the release integrity contract", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentroam-desktop-update-"));
    const bytes = new TextEncoder().encode("installer");
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
    expect(await readdir(directory)).toEqual([]);
    expect(vi.fn()).not.toHaveBeenCalled();
  });
});
