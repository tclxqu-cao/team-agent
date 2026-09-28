import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeDesktopFlowStudioEntryUrl,
  resolveDesktopFlowStudioEntryUrl,
} from "./desktop-flow-studio-entry";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop Flow Studio entry", () => {
  it("reads the configured entry through the authenticated shared service", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ entryUrl: "https://flow.example/auth/entry?token=test" }),
    });
    vi.stubGlobal("window", { sharedServiceApi: { request } });

    await expect(resolveDesktopFlowStudioEntryUrl()).resolves.toBe(
      "https://flow.example/auth/entry?token=test",
    );
    expect(request).toHaveBeenCalledWith("/api/flow-studio/config", "GET");
  });

  it("preserves the configured address for the native embedded page", () => {
    expect(normalizeDesktopFlowStudioEntryUrl(
      "http://127.0.0.1:8788/auth/entry?token=test",
    )).toBe("http://127.0.0.1:8788/auth/entry?token=test");
  });

  it("rejects non-http embedded-page entry URLs", () => {
    expect(normalizeDesktopFlowStudioEntryUrl("file:///tmp/flow.html")).toBeNull();
    expect(normalizeDesktopFlowStudioEntryUrl("javascript:alert(1)")).toBeNull();
  });

  it("fails closed when the entry is unavailable", async () => {
    vi.stubGlobal("window", {
      sharedServiceApi: {
        request: vi.fn().mockResolvedValue({ status: 200, body: "{\"entryUrl\":null}" }),
      },
    });

    await expect(resolveDesktopFlowStudioEntryUrl()).resolves.toBeNull();
  });
});
