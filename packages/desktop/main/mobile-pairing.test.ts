import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobilePairingInvitation, pairingOrigin } from "./mobile-pairing";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("desktop mobile invitation", () => {
  it("refuses loopback, embedded credentials and malformed public addresses", () => {
    for (const raw of ["http://localhost:3000/web", "file:///web", "https://user:password@example.com/web", "https://example.com/web#secret", "https://example.com/api"])
      expect(() => pairingOrigin(raw)).toThrow();
    expect(pairingOrigin("https://computer.example/web\n")).toBe("https://computer.example");
  });
  it("requires a phone address before minting an invitation and handles locks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobile-qr-")); directories.push(directory);
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ grant: "g".repeat(43), expiresAt: Date.now() + 300000 }) }));
    await expect(createMobilePairingInvitation(directory, request)).rejects.toThrow("尚未建立");
    expect(request).not.toHaveBeenCalled();
    await writeFile(join(directory, "tunnel.url"), "https://computer.example/web");
    const result = await createMobilePairingInvitation(directory, request);
    expect(result.origin).toBe("https://computer.example"); expect(result.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(result.svg).not.toContain("g".repeat(43));
    await expect(createMobilePairingInvitation(directory, async () => ({ status: 423, body: "{}" }))).rejects.toThrow("已锁定");
  });
});
