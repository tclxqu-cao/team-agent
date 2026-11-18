import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { persistentServiceId } from "./service-identity.mjs";
describe("persistent service identity", () => {
  it("stays stable for one data root and isolates a second root", () => {
    const root = mkdtempSync(join(tmpdir(), "todo-identity-"));
    try { const id = persistentServiceId(root); expect(persistentServiceId(root)).toBe(id); expect(persistentServiceId(join(root, "another"))).not.toBe(id); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
