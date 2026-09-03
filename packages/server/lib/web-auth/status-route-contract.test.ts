import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const statusRoute = readFileSync(
  new URL("../../app/api/web-auth/status/route.ts", import.meta.url),
  "utf8",
);

describe("web auth status route", () => {
  it("stays dynamic so authentication changes are visible after setup", () => {
    expect(statusRoute).toContain('export const dynamic = "force-dynamic"');
  });
});
