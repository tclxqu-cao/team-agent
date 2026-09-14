import { describe, expect, it } from "vitest";
import { GET } from "../../app/api/web-console/bootstrap/route";

describe("console bootstrap entry", () => {
  it("fails closed when accessed without the authenticated gateway", async () => {
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("wsNonce");
  });
});
