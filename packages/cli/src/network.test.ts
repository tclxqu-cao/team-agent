import { describe, expect, it } from "vitest";
import { findLanUrl } from "./network.js";

describe("findLanUrl", () => {
  it("prefers an RFC1918 address over VPN and public interfaces", () => {
    expect(findLanUrl(52032, {
      utun7: [{ address: "100.121.10.115", netmask: "255.255.255.255", family: "IPv4", mac: "", internal: false, cidr: null }],
      en0: [{ address: "10.22.34.143", netmask: "255.255.252.0", family: "IPv4", mac: "", internal: false, cidr: null }],
    })).toBe("http://10.22.34.143:52032");
  });

  it("falls back to the first external IPv4 address", () => {
    expect(findLanUrl(4100, {
      utun7: [{ address: "100.121.10.115", netmask: "255.255.255.255", family: "IPv4", mac: "", internal: false, cidr: null }],
    })).toBe("http://100.121.10.115:4100");
  });

  it("returns null when only loopback is available", () => {
    expect(findLanUrl(4100, {
      lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: null }],
    })).toBeNull();
  });
});
