import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("update route security contract", () => {
  const check = readFileSync(resolve(__dirname, "check/route.ts"), "utf8");
  const install = readFileSync(resolve(__dirname, "install/route.ts"), "utf8");

  it("keeps update checks background-only and rejects cross-site POST", () => {
    expect(check).toContain("requestCheck()");
    expect(check).toContain('request.headers.get("sec-fetch-site") === "cross-site"');
    expect(check).toContain("status: 202");
  });

  it("does not accept a renderer supplied URL, hash, or version", () => {
    expect(install).toContain("update install does not accept parameters");
    expect(install).not.toMatch(/body\.(?:url|sha256|version)/);
    expect(install).toContain('request.headers.get("sec-fetch-site") === "cross-site"');
  });
});
