import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("webapp build watchdog", () => {
  it("bypasses browser caches when checking the deployed build id", () => {
    expect(mainSource).toMatch(
      /fetch\("\/api\/agent\/model",\s*\{[\s\S]*?credentials: "same-origin",[\s\S]*?cache: "no-store",[\s\S]*?\}\)/,
    );
  });
});
