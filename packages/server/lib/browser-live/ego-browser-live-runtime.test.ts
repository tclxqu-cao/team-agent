import { describe, expect, it } from "vitest";
import { startEgoBrowserLive, viewportFromPageInfo } from "./ego-browser-live-runtime.mjs";

describe("ego-browser live runtime", () => {
  it("maps ego pageInfo dimensions to the shared viewport model", () => {
    expect(viewportFromPageInfo({ w: 1457.4, h: 1065.6 })).toEqual({
      width: 1457,
      height: 1066,
      deviceScaleFactor: 1,
    });
  });

  it("rejects native-dialog pageInfo without a viewport", () => {
    expect(() => viewportFromPageInfo({ dialog: { type: "alert" } })).toThrow("usable browser viewport");
  });

  it("requires the dedicated screencast subscription instead of drainEvents", async () => {
    await expect(startEgoBrowserLive({
      cdp: async () => undefined,
      pageInfo: async () => ({ w: 800, h: 600 }),
    })).rejects.toThrow("screencast subscribe");
  });
});
