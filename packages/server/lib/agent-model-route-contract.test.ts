import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelRoute = readFileSync(
  new URL("../app/api/agent/model/route.ts", import.meta.url),
  "utf8",
);

describe("agent model route", () => {
  it("reads the active build id for every request without response caching", () => {
    expect(modelRoute).toContain('export const dynamic = "force-dynamic"');
    expect(modelRoute).toContain('headers: { "cache-control": "no-store" }');
  });
});
