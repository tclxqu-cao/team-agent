import { describe, expect, it } from "vitest";
import { OpenCodeServerClient } from "./opencode-server-client.js";

describe("OpenCodeServerClient", () => {
  it("reports a missing executable without waiting for the health timeout", async () => {
    const client = new OpenCodeServerClient({ executable: "/definitely/missing/agentroam-opencode" });
    const started = Date.now();
    await expect(client.client()).rejects.toThrow(/ENOENT|missing/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    await client.dispose();
  });
});
