import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password security", () => {
  it("hashes and verifies without retaining plaintext", async () => {
    const password = "correct horse battery staple";
    const record = await hashPassword(password);
    expect(record.hash.toString("utf8")).not.toContain("correct horse");
    await expect(verifyPassword(password, record)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", record)).resolves.toBe(false);
  });
});
