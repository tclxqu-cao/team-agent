import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarnessLocalCookie, readHarnessLocalCookie } from "./deepseek-harness-local-auth.js";

const secret = Buffer.alloc(32, 7).toString("base64url");
const credentials = `version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`;

describe("Harness native local authentication", () => {
  it.each(["http://127.0.0.1:9020", "https://localhost:9020", "http://[::1]:9020"])("scopes the cookie to the native audience for %s", origin => {
    const cookie = createHarnessLocalCookie(origin, credentials, 10_000)!;
    expect(cookie).toMatch(/^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(cookie.split(".")[1]!, "base64url").toString());
    expect(payload).toEqual({ version: 1, authority: origin.startsWith("https:") ? origin : new URL(origin).host,
      issuedAt: 10_000, expiresAt: 310_000 });
    expect(cookie).not.toContain(secret);
    expect(createHarnessLocalCookie("http://127.0.0.1:9021", credentials, 10_000)).not.toBe(cookie);
  });

  it.each([
    credentials.replace("version: 1", "version: 2"),
    credentials.replace("kind: grant", "kind: api-key"),
    credentials.replace(secret, "invalid-secret"),
    credentials.replace("      version: 1", "      version: 2"),
    credentials + "version: 1\n",
    "version: [broken-secret",
  ])("rejects unknown or malformed native credential formats without leaking source", document => {
    expect(createHarnessLocalCookie("http://127.0.0.1:9020", document)).toBeNull();
  });

  it("refuses external origins and URLs carrying credentials", () => {
    expect(createHarnessLocalCookie("https://external.example", credentials)).toBeNull();
    expect(createHarnessLocalCookie("http://user:password@localhost:9020", credentials)).toBeNull();
  });

  it("reads only an owner-protected native store and respects DSH_HOME", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-auth-"));
    const filename = join(directory, ".credentials.yaml");
    try {
      expect(await readHarnessLocalCookie("http://localhost:9020", { DSH_HOME: directory })).toBeNull();
      await writeFile(filename, credentials, { mode: 0o600 });
      expect(await readHarnessLocalCookie("http://localhost:9020", { DSH_HOME: directory })).toMatch(/^dsh-auth-/);
      if (process.platform !== "win32") {
        await chmod(filename, 0o644);
        expect(await readHarnessLocalCookie("http://localhost:9020", { DSH_HOME: directory })).toBeNull();
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
