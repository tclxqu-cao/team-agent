import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteAuthStore } from "../../infrastructure/SQLiteAuthStore.js";
import { WebAuthError, WebAuthService } from "./WebAuthService.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "customer-agent-auth-service-"));
  let current = new Date("2026-08-27T00:00:00.000Z");
  const service = new WebAuthService(new SQLiteAuthStore(base), () => current);
  return { base, service, advance(ms: number) { current = new Date(current.getTime() + ms); } };
}

describe("WebAuthService", () => {
  it("creates the first account and authenticates a 30-day session", async () => {
    const f = fixture();
    const result = await f.service.setup("CaoQu", "correct-horse-123", { ip: "127.0.0.1", userAgent: "vitest", deviceId: "phone" });
    expect(result.user.username).toBe("CaoQu");
    expect(f.service.authenticateToken(result.authToken).principal.deviceId).toBe("phone");
    await expect(f.service.setup("second", "correct-horse-123", { ip: "127.0.0.1", userAgent: "vitest" })).rejects.toMatchObject({ code: "SETUP_COMPLETED" });
    rmSync(f.base, { recursive: true, force: true });
  });

  it("rotates CSRF, consumes WebSocket nonce once, and revokes logout", async () => {
    const f = fixture();
    const result = await f.service.setup("caoqu", "correct-horse-123", { ip: "127.0.0.1", userAgent: "vitest" });
    const refreshed = f.service.refresh(result.authToken);
    const auth = f.service.authenticateToken(result.authToken);
    expect(() => f.service.validateCsrf(auth, refreshed.csrfToken)).not.toThrow();
    const ws = f.service.issueWsNonce(result.authToken);
    expect(f.service.consumeWsNonce(result.authToken, ws.nonce).userId).toBe(result.user.id);
    expect(() => f.service.consumeWsNonce(result.authToken, ws.nonce)).toThrow(WebAuthError);
    f.service.logout(result.authToken);
    expect(() => f.service.authenticateToken(result.authToken)).toThrow(WebAuthError);
    rmSync(f.base, { recursive: true, force: true });
  });

  it("rate limits repeated invalid login attempts", async () => {
    const f = fixture();
    await f.service.setup("caoqu", "correct-horse-123", { ip: "127.0.0.1", userAgent: "vitest" });
    for (let index = 0; index < 5; index++) {
      await expect(f.service.login("caoqu", "wrong-password", { ip: "10.0.0.1", userAgent: "vitest" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    await expect(f.service.login("caoqu", "wrong-password", { ip: "10.0.0.1", userAgent: "vitest" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    rmSync(f.base, { recursive: true, force: true });
  });
});
