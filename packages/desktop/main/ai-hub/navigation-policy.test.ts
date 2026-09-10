import { describe, expect, it } from "vitest";
import { isGoogleAuthUrl } from "./navigation-policy";

describe("isGoogleAuthUrl", () => {
  it("matches secure Google Accounts navigation", () => {
    expect(isGoogleAuthUrl("https://accounts.google.com/v3/signin/identifier?continue=x")).toBe(true);
    expect(isGoogleAuthUrl("https://region.accounts.google.com/signin")).toBe(true);
  });

  it("rejects insecure, malformed, and lookalike URLs", () => {
    expect(isGoogleAuthUrl("http://accounts.google.com/signin")).toBe(false);
    expect(isGoogleAuthUrl("https://accounts.google.com.evil.example/signin")).toBe(false);
    expect(isGoogleAuthUrl("https://evil-accounts.google.com/signin")).toBe(false);
    expect(isGoogleAuthUrl("not a url")).toBe(false);
  });
});
