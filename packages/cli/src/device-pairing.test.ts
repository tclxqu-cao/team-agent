import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { pairingQrPayload, watchPairingApproval, type pairingAdmin } from "./device-pairing.js";

describe("local approval commands", () => {
  it("encodes a separate QR invitation and validates the server URL", () => {
    expect(parseArgs(["pair", "--url", "https://phone.example/web"]).pairingUrl).toBe("https://phone.example/web");
    const link = new URL(pairingQrPayload("https://phone.example/web", "a".repeat(43)));
    expect(link.origin + link.pathname).toBe("https://phone.example/pair");
    expect(link.search).toBe(""); expect(link.hash).toBe(`#pair=${"a".repeat(43)}`);
    expect(() => pairingQrPayload("https://user:password@phone.example", "a".repeat(43))).toThrow();
  });
  const id = "12345678-1234-1234-1234-123456789abc";
  it("requires a request ID and matching phrase for explicit approval", () => {
    expect(() => parseArgs(["approve", id])).toThrow(/phrase/);
    expect(parseArgs(["approve", id, "--phrase", "松林·月光·1234"])).toMatchObject({ approvalRequestId: id, approvalPhrase: "松林·月光·1234" });
    for (const command of ["lock", "unlock", "audit", "approvals"]) expect(parseArgs([command]).command).toBe(command);
    expect(parseArgs(["deny", id]).approvalRequestId).toBe(id);
  });
  it.each([true, false])("displays the phrase and sends only the local user's %s decision", async (approve) => {
    const now = Date.now();
    const request = { id, name: "Phone\u001b[31m", phrase: "松林·月光·1234", created: now, expires: now + 300_000, status: "waiting" };
    const admin = vi.fn().mockResolvedValueOnce({ requests: [request], locked: false }).mockResolvedValueOnce({ status: approve ? "approved" : "denied" });
    const log = vi.fn(); const confirm = vi.fn(async () => approve);
    await watchPairingApproval("/tmp/unused", now + 300_000, { admin: admin as typeof pairingAdmin, log, confirm });
    expect(log).toHaveBeenCalledWith(`核对短语：${request.phrase}`);
    expect(confirm).toHaveBeenCalledWith(request, undefined);
    expect(admin).toHaveBeenLastCalledWith("/tmp/unused", approve ? "approve" : "deny", { id, ...(approve ? { phrase: request.phrase } : {}) });
    expect(log.mock.calls.flat().join("\n")).not.toContain("\u001b");
  });
});
