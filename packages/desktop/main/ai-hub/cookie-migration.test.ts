import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cdpCookieToElectronDetails,
  chromeTimestampToUnixSeconds,
  chromiumRowToCookieDetails,
  collectCookieDetails,
  cookiesBelongingToHosts,
  decryptChromiumV10Value,
  deriveChromiumCookieKey,
  mapChromiumSameSite,
  type ChromiumCookieRow,
} from "./cookie-migration";

const SECRET = "unit-test-secret";

function encryptV10(plain: string, secret = SECRET): Buffer {
  const cipher = createCipheriv("aes-128-cbc", deriveChromiumCookieKey(secret), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(plain, "utf8"), cipher.final()]);
}

const NOW = 1_700_000_000;
const FAR_FUTURE_CHROME_MICROS = (NOW + 86_400) * 1_000_000 + 11_644_473_600_000_000;
const PAST_CHROME_MICROS = (NOW - 86_400) * 1_000_000 + 11_644_473_600_000_000;

function baseRow(overrides: Partial<ChromiumCookieRow> = {}): ChromiumCookieRow {
  return {
    host_key: ".example.com",
    name: "sid",
    value: "",
    encrypted_value: encryptV10("cookie-value"),
    path: "/",
    expires_utc: FAR_FUTURE_CHROME_MICROS,
    is_secure: 1,
    is_httponly: 1,
    is_persistent: 1,
    has_expires: 1,
    samesite: 1,
    top_frame_site_id: null,
    partition_id: 0,
    ...overrides,
  };
}

describe("chromium v10 decryption", () => {
  it("derives the macOS PBKDF2 key and decrypts v10 payloads", () => {
    const encrypted = encryptV10("hello-cookie");
    expect(decryptChromiumV10Value(encrypted, SECRET)).toBe("hello-cookie");
  });

  it("fails closed with null on wrong secret or foreign prefixes", () => {
    expect(decryptChromiumV10Value(encryptV10("x", "other-secret"), SECRET)).toBeNull();
    expect(decryptChromiumV10Value(Buffer.from("v11-not-for-mac", "utf8"), SECRET)).toBeNull();
    expect(decryptChromiumV10Value(Buffer.alloc(0), SECRET)).toBeNull();
  });
});

describe("timestamp and samesite conversion", () => {
  it("converts Chromium epoch microseconds to Unix seconds", () => {
    expect(chromeTimestampToUnixSeconds(13_350_000_000_000_000)).toBe(1_705_526_400);
  });

  it("maps Chromium samesite ints onto Electron names", () => {
    expect(mapChromiumSameSite(-1)).toBe("unspecified");
    expect(mapChromiumSameSite(0)).toBe("no_restriction");
    expect(mapChromiumSameSite(1)).toBe("lax");
    expect(mapChromiumSameSite(2)).toBe("strict");
    expect(mapChromiumSameSite(null)).toBe("unspecified");
  });
});

describe("chromiumRowToCookieDetails", () => {
  it("converts a host-only plaintext session cookie without a domain", () => {
    const outcome = chromiumRowToCookieDetails(baseRow({
      host_key: "news.example.com",
      encrypted_value: null,
      value: "plain",
      is_persistent: 0,
      has_expires: 0,
      expires_utc: 0,
      path: "/a",
    }), SECRET, NOW);
    expect(outcome).toEqual({
      status: "ok",
      details: {
        url: "https://news.example.com/a",
        name: "sid",
        value: "plain",
        path: "/a",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
    });
  });

  it("skips expired, malformed, partitioned, and undecryptable cookies", () => {
    expect(chromiumRowToCookieDetails(baseRow({ expires_utc: PAST_CHROME_MICROS }), SECRET, NOW))
      .toEqual({ status: "skip", reason: "expired" });
    expect(chromiumRowToCookieDetails(baseRow({ name: "" }), SECRET, NOW))
      .toEqual({ status: "skip", reason: "malformed" });
    expect(chromiumRowToCookieDetails(baseRow({ top_frame_site_id: "abc" }), SECRET, NOW))
      .toEqual({ status: "skip", reason: "partitioned" });
    expect(chromiumRowToCookieDetails(baseRow({ encrypted_value: Buffer.from("v10-corrupt-padding!!!") }), SECRET, NOW))
      .toEqual({ status: "skip", reason: "undecryptable" });
  });
});

describe("collectCookieDetails", () => {
  it("counts outcomes without exposing values", () => {
    const summary = collectCookieDetails({
      keychainSecret: SECRET,
      nowUnixSec: NOW,
      rows: [
        baseRow(),
        baseRow({ name: "plain-one", encrypted_value: null, value: "p" }),
        baseRow({ name: "old", expires_utc: PAST_CHROME_MICROS }),
        baseRow({ name: "part", partition_id: 7 }),
        baseRow({ name: "bad", encrypted_value: Buffer.from("v10-broken-junk!!!") }),
      ],
    });
    expect(summary.total).toBe(5);
    expect(summary.imported).toBe(2);
    expect(summary.skipped).toEqual({ expired: 1, malformed: 0, partitioned: 1, undecryptable: 1 });
    const serialized = JSON.stringify(summary.details);
    expect(serialized).not.toContain(SECRET);
  });
});

describe("cdp cookies", () => {
  it("converts CDP cookies into Electron details", () => {
    expect(cdpCookieToElectronDetails({
      name: "SID",
      value: "v",
      domain: ".google.com",
      path: "/",
      expires: 1_800_000_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })).toEqual({
      url: "https://google.com/",
      name: "SID",
      value: "v",
      domain: ".google.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: 1_800_000_000,
      sameSite: "lax",
    });
  });

  it("keeps only cookies belonging to the target hosts", () => {
    const cookies = [
      { name: "a", domain: ".google.com" },
      { name: "b", domain: "accounts.google.com" },
      { name: "c", domain: ".gemini.google.com" },
      { name: "d", domain: ".evil-example.com" },
      { name: "e", domain: "notgoogle.com" },
    ];
    expect(cookiesBelongingToHosts(cookies, ["google.com"]).map((cookie) => cookie.name)).toEqual(["a", "b", "c"]);
  });
});
