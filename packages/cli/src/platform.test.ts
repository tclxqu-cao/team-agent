import { describe, expect, it } from "vitest";
import { detectPlatform, detectPlatformTarget } from "./platform.js";

describe("detectPlatform", () => {
  it("maps supported targets", () => {
    expect(detectPlatform("darwin", "arm64", "22.22.0")).toBe("darwin-arm64");
    expect(detectPlatform("win32", "x64", "25.8.0")).toBe("windows-amd64");
  });

  it("detects a target before Node version validation", () => {
    expect(detectPlatformTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectPlatformTarget("win32", "x64")).toBe("windows-amd64");
  });

  it("rejects unsupported versions", () => {
    expect(() => detectPlatform("darwin", "arm64", "22.21.9")).toThrow("Node.js >=22.22.0");
  });

  it("rejects unsupported platforms", () => {
    expect(() => detectPlatformTarget("linux", "x64")).toThrow("unsupported platform");
  });
});
