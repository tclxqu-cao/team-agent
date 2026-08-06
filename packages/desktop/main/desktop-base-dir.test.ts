import { describe, expect, it } from "vitest";

describe("resolveDesktopBaseDir", () => {
  it("uses the desktop app directory so existing development data is preserved", async () => {
    let module: typeof import("./desktop-base-dir") | undefined;
    try {
      module = await import("./desktop-base-dir");
    } catch {
      // The first TDD run proves the resolver does not exist yet.
    }

    expect(module?.resolveDesktopBaseDir(
      "/repo/packages/desktop",
      false,
      "/Users/test/Library/Application Support/Desktop",
    )).toBe("/repo/packages/desktop");
  });

  it("uses userData for a packaged desktop app", async () => {
    let module: typeof import("./desktop-base-dir") | undefined;
    try {
      module = await import("./desktop-base-dir");
    } catch {
      // The first TDD run proves the resolver does not exist yet.
    }

    expect(module?.resolveDesktopBaseDir(
      "/Applications/Desktop.app/Contents/Resources/app.asar",
      true,
      "/Users/test/Library/Application Support/Desktop",
    )).toBe("/Users/test/Library/Application Support/Desktop");
  });
});
