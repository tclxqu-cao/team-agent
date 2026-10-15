import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteAuthStore } from "../../core/src/infrastructure/SQLiteAuthStore";
import { SQLiteWebConsoleStore } from "../../core/src/infrastructure/SQLiteWebConsoleStore";
import { SQLiteDatabase, getDatabase } from "../../core/src/infrastructure/SQLiteDatabase";

const state = vi.hoisted(() => ({ store: null as SQLiteWebConsoleStore | null }));
vi.mock("@agent/core", async () => import("../../core/src/domain/web-console/computer-directory"));
vi.mock("./web-auth/anonymous", () => ({
  anonymousPrincipal: () => ({ userId: "owner" }),
  webConsoleStore: {
    listComputerConnections: (id: string) => state.store!.listComputerConnections(id),
    mergeComputerConnections: (...args: Parameters<SQLiteWebConsoleStore["mergeComputerConnections"]>) => state.store!.mergeComputerConnections(...args),
    renameComputerConnection: (...args: Parameters<SQLiteWebConsoleStore["renameComputerConnection"]>) => state.store!.renameComputerConnection(...args),
    removeComputerConnection: (...args: Parameters<SQLiteWebConsoleStore["removeComputerConnection"]>) => state.store!.removeComputerConnection(...args),
  },
}));
import { DELETE, GET, PATCH, POST } from "../app/api/web-console/computers/route";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "computer-connections-api-"));
  const now = new Date().toISOString();
  new SQLiteAuthStore(base).createFirstUser({ id: "owner", usernameNormalized: "local", usernameDisplay: "local", passwordHash: Buffer.alloc(32), passwordSalt: Buffer.alloc(16), passwordVersion: 1, createdAt: now, passwordChangedAt: now });
  state.store = new SQLiteWebConsoleStore(base);
});
afterEach(() => { getDatabase(base).close(); rmSync(base, { recursive: true, force: true }); });
const company = { origin: "http://100.121.10.115:3000", name: "公司" };
const home = { origin: "https://home.example", name: "家里" };
const request = (body: unknown, method = "POST") => new Request("http://computer/api/web-console/computers", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("shared computer directory with SQLite", () => {
  it("rejects deleting the current connection and preserves its database record", async () => {
    await POST(request({ computers: [company, home] }));
    const response = await DELETE(new Request(company.origin + "/api/web-console/computers", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: company.origin }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("不能删除当前连接的电脑。");
    expect(await (await GET()).json()).toEqual({ computers: [company, home] });
  });

  it("protects the browser's current origin when the gateway request uses an internal URL", async () => {
    await POST(request({ computers: [company, home] }));
    const response = await DELETE(new Request("http://127.0.0.1:3000/api/web-console/computers", {
      method: "DELETE", headers: { "content-type": "application/json", origin: company.origin }, body: JSON.stringify({ origin: company.origin }),
    }));
    expect(response.status).toBe(400);
    expect(await (await GET()).json()).toEqual({ computers: [company, home] });
    expect((await DELETE(new Request(company.origin + "/api/web-console/computers", {
      method: "DELETE", headers: { "content-type": "application/json", origin: company.origin }, body: JSON.stringify({ origin: home.origin }),
    }))).status).toBe(200);
    expect(await (await GET()).json()).toEqual({ computers: [company] });
  });

  it("shares a phone's imported computers with a fresh browser and retains them after reopening", async () => {
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
    expect((await POST(request({ computers: [company, home] }))).status).toBe(200);
    // A fresh desktop has only its current origin. Additive import keeps the phone's second computer.
    expect(await (await POST(request({ computers: [{ ...company, name: "100.121.10.115" }] }))).json()).toEqual({ computers: [company, home] });
    expect(await (await GET()).json()).toEqual({ computers: [company, home] });
    getDatabase(base).close();
    const reopened = new SQLiteDatabase(base);
    expect(reopened.db.prepare("SELECT origin,name FROM computer_connections ORDER BY rowid").all()).toEqual([company, home]);
    reopened.close();
  });

  it("persists renames without stale browser imports reversing them or other records being lost", async () => {
    await POST(request({ computers: [company, home] }));
    const renamed = { ...company, name: "公司电脑" };
    expect((await PATCH(request(renamed, "PATCH"))).status).toBe(200);
    await POST(request({ computers: [company, home] }));
    expect(await (await GET()).json()).toEqual({ computers: [renamed, home] });
    expect(state.store!.listComputerConnections("another-owner")).toEqual([]);
    expect((await PATCH(request({ ...home, origin: "https://missing.example" }, "PATCH"))).status).toBe(404);
  });

  it("imports the phone's custom name after a new browser registered the hostname, without undoing explicit renames", async () => {
    const defaultName = { ...company, name: "100.121.10.115" };
    await POST(request({ computers: [defaultName] }));
    await POST(request({ computers: [company] }));
    expect(await (await GET()).json()).toEqual({ computers: [company] });
    await PATCH(request(defaultName, "PATCH"));
    await POST(request({ computers: [company] }));
    expect(await (await GET()).json()).toEqual({ computers: [defaultName] });
  });

  it("rejects credentials, arbitrary URLs and owner overrides without changing the directory", async () => {
    for (const computers of [
      [{ ...home, token: "secret" }], [{ ...home, pages: [] }], [{ ...home, origin: "https://user:secret@home.example" }],
      [{ ...home, origin: "javascript:alert(1)" }], [{ ...home, origin: "https://home.example/api/run" }],
      [{ ...home, origin: "https://home.example?token=secret" }], [{ ...home, name: " " }], [home, home],
    ]) expect((await POST(request({ computers }))).status).toBe(400);
    expect((await POST(request({ userId: "another-owner", computers: [home] }))).status).toBe(400);
    expect((await POST(new Request("http://computer/api", { method: "POST", body: "{" }))).status).toBe(400);
    expect(await (await GET()).json()).toEqual({ computers: [] });
  });

  it("bounds the combined directory atomically across independent browser imports", async () => {
    const full = Array.from({ length: 20 }, (_, index) => ({ origin: `https://c${index}.example`, name: `电脑 ${index}` }));
    expect((await POST(request({ computers: full }))).status).toBe(200);
    expect((await POST(request({ computers: [home] }))).status).toBe(400);
    expect(await (await GET()).json()).toEqual({ computers: full });
  });

  it("shares deletions, ignores stale phone caches, and allows an explicit add to restore the computer", async () => {
    await POST(request({ computers: [company, home] }));
    expect((await DELETE(request({ origin: home.origin }, "DELETE"))).status).toBe(200);
    expect(await (await GET()).json()).toEqual({ computers: [company] });
    await POST(request({ computers: [company, home] }));
    expect(await (await GET()).json()).toEqual({ computers: [company] });
    expect((await PATCH(request(home, "PATCH"))).status).toBe(404);
    await POST(request({ computers: [home], restore: true }));
    expect(await (await GET()).json()).toEqual({ computers: [company, home] });
    await DELETE(request({ origin: company.origin }, "DELETE"));
    await POST(request({ computers: [company] }));
    expect(await (await GET()).json()).toEqual({ computers: [home] });
    expect((await DELETE(request({ origin: home.origin, userId: "other" }, "DELETE"))).status).toBe(400);
  });

  it("adds the table to an existing database while preserving saved page and toolbar settings", () => {
    const value = { userId: "owner", revision: 7, visibleTools: [] as [], savedPages: [], updatedAt: "2026-10-14T00:00:00.000Z" };
    state.store!.saveComputerSettings(value, null);
    getDatabase(base).db.exec("DROP TABLE computer_connections");
    const migrated = new SQLiteDatabase(base);
    expect(migrated.db.prepare("SELECT count(*) AS count FROM computer_connections").get()).toEqual({ count: 0 });
    migrated.close();
    expect(state.store!.getComputerSettings("owner")).toEqual(value);
  });
});
