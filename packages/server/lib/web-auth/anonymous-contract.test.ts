import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const anonymousAuth = readFileSync(new URL("./anonymous.ts", import.meta.url), "utf8");
const bootstrapRoute = readFileSync(
  new URL("../../app/api/web-console/bootstrap/route.ts", import.meta.url),
  "utf8",
);
const gateway = readFileSync(new URL("../../ws-server.mjs", import.meta.url), "utf8");

describe("passwordless web nonce contract", () => {
  it("keeps bootstrap dynamic and shares nonce state through SQLite", () => {
    expect(bootstrapRoute).toContain('export const dynamic = "force-dynamic"');
    expect(anonymousAuth).toContain("new SQLiteAnonymousWebStore(getServerBaseDir())");
    expect(gateway).toContain("new SQLiteAnonymousWebStore(serverBaseDir)");
    expect(anonymousAuth).not.toContain("__webAnonNonces");
    expect(gateway).not.toContain("__webAnonNonces");
  });
});
