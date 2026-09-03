import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const healthRoute = readFileSync(
  new URL("../app/api/agent/runtime-health/route.ts", import.meta.url),
  "utf8",
);

describe("native runtime health route", () => {
  it("stays dynamic so health is evaluated at request time", () => {
    expect(healthRoute).toContain('export const dynamic = "force-dynamic"');
  });
});
