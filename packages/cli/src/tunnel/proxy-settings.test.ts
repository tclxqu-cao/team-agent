import { describe, expect, it, vi } from "vitest";
import { parseMacSystemProxy, resolveProxyForUrl } from "./proxy-settings.js";

const target = new URL("https://api.example.test/status");

describe("resolveProxyForUrl", () => {
  it("prefers the lowercase HTTPS proxy and normalizes an omitted scheme", async () => {
    await expect(
      resolveProxyForUrl(target, {
        env: {
          https_proxy: "127.0.0.1:7897",
          HTTPS_PROXY: "http://uppercase.test:8080",
          HTTP_PROXY: "http://http.test:8080",
        },
        platform: "linux",
      }),
    ).resolves.toBe("http://127.0.0.1:7897/");
  });

  it("uses HTTP_PROXY as the HTTPS fallback and ALL_PROXY for HTTP", async () => {
    await expect(
      resolveProxyForUrl(target, { env: { HTTP_PROXY: "http://http.test:8080" }, platform: "linux" }),
    ).resolves.toBe("http://http.test:8080/");
    await expect(
      resolveProxyForUrl(new URL("http://example.test"), {
        env: { ALL_PROXY: "https://all.test:8443" },
        platform: "linux",
      }),
    ).resolves.toBe("https://all.test:8443/");
  });

  it.each([
    ["*", "https://api.example.test/status"],
    ["api.example.test", "https://api.example.test/status"],
    [".example.test", "https://api.example.test/status"],
    ["example.test", "https://api.example.test/status"],
    ["api.example.test:443", "https://api.example.test/status"],
    ["api.example.test:8443", "https://api.example.test:8443/status"],
  ])("bypasses the proxy for NO_PROXY=%s", async (noProxy, url) => {
    await expect(
      resolveProxyForUrl(new URL(url), {
        env: { HTTPS_PROXY: "http://proxy.test:8080", NO_PROXY: noProxy },
        platform: "darwin",
        readMacSystemProxy: vi.fn(async () => macProxyOutput()),
      }),
    ).resolves.toBeNull();
  });

  it("does not bypass a suffix lookalike or a rule with a different port", async () => {
    await expect(
      resolveProxyForUrl(target, {
        env: { HTTPS_PROXY: "http://proxy.test:8080", no_proxy: "notexample.test,api.example.test:8443" },
        platform: "linux",
      }),
    ).resolves.toBe("http://proxy.test:8080/");
  });

  it("falls back to uppercase NO_PROXY when the lowercase value is empty", async () => {
    await expect(
      resolveProxyForUrl(target, {
        env: { HTTPS_PROXY: "http://proxy.test:8080", no_proxy: "", NO_PROXY: "example.test" },
        platform: "linux",
      }),
    ).resolves.toBeNull();
  });

  it("falls back to the enabled macOS HTTPS proxy", async () => {
    await expect(
      resolveProxyForUrl(target, {
        env: {},
        platform: "darwin",
        readMacSystemProxy: async () => macProxyOutput(),
      }),
    ).resolves.toBe("http://127.0.0.1:7897/");
  });

  it("uses the macOS HTTP proxy when HTTPS proxying is disabled", async () => {
    await expect(
      resolveProxyForUrl(target, {
        env: {},
        platform: "darwin",
        readMacSystemProxy: async () => macProxyOutput({ httpsEnabled: false }),
      }),
    ).resolves.toBe("http://127.0.0.1:7898/");
  });

  it("returns direct mode for command failures and non-macOS platforms", async () => {
    await expect(
      resolveProxyForUrl(target, {
        env: {},
        platform: "darwin",
        readMacSystemProxy: async () => {
          throw new Error("scutil failed");
        },
      }),
    ).resolves.toBeNull();

    const reader = vi.fn(async () => macProxyOutput());
    await expect(resolveProxyForUrl(target, { env: {}, platform: "linux", readMacSystemProxy: reader })).resolves.toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("parseMacSystemProxy", () => {
  it("parses enabled HTTP and HTTPS settings", () => {
    expect(parseMacSystemProxy(macProxyOutput())).toEqual({
      httpProxy: "http://127.0.0.1:7898/",
      httpsProxy: "http://127.0.0.1:7897/",
    });
  });

  it("ignores disabled and malformed settings", () => {
    expect(
      parseMacSystemProxy(`
        HTTPEnable : 0
        HTTPProxy : 127.0.0.1
        HTTPPort : 7898
        HTTPSEnable : 1
        HTTPSProxy : 127.0.0.1
        HTTPSPort : not-a-port
      `),
    ).toEqual({ httpProxy: null, httpsProxy: null });

    expect(parseMacSystemProxy("HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 70000")).toEqual({
      httpProxy: null,
      httpsProxy: null,
    });
    expect(parseMacSystemProxy("HTTPSEnable : 1\nHTTPSProxy : proxy.test/path\nHTTPSPort : 7897")).toEqual({
      httpProxy: null,
      httpsProxy: null,
    });
  });
});

function macProxyOutput({ httpsEnabled = true }: { httpsEnabled?: boolean } = {}): string {
  return `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7898
  HTTPProxy : 127.0.0.1
  HTTPSEnable : ${httpsEnabled ? "1" : "0"}
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}`;
}
