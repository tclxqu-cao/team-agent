import { describe, expect, it } from "vitest";
import {
  COMPUTER_STORAGE_KEY, computerNavigation, mergeComputers, normalizeComputers,
  pairingNavigation, parsePairingTarget, readComputerHandoff, readComputers,
  rememberComputer, saveComputers,
} from "../public/pwa/computer-directory.js";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
}
const a = { origin: "https://a.example", name: "A 电脑" };
const b = { origin: "https://b.example", name: "B 电脑" };
const grant = "g".repeat(43);

describe("browser computer directory", () => {
  it("carries A to B and returns to A across independent origin stores without copying credentials", () => {
    const storeA = storage(), storeB = storage();
    saveComputers([a], storeA);
    const target = new URL(pairingNavigation(`${b.origin}/pair#pair=${grant}`, readComputers(storeA), b.name));
    expect(target.pathname).toBe("/pair");
    expect(new URLSearchParams(target.hash.slice(1)).get("pair")).toBe(grant);
    const incoming = readComputerHandoff(target.hash);
    saveComputers(mergeComputers(readComputers(storeB), incoming.computers), storeB);
    expect(readComputers(storeB)).toEqual([a]); // B is not registered until authorization succeeds.
    saveComputers(rememberComputer(b.origin, incoming.name, readComputers(storeB)), storeB);
    const back = new URL(computerNavigation(a.origin, readComputers(storeB)));
    expect(back.pathname).toBe("/pair");
    expect(new URLSearchParams(back.hash.slice(1)).has("pair")).toBe(false);
    saveComputers(mergeComputers(readComputers(storeA), readComputerHandoff(back.hash).computers), storeA);
    expect(readComputers(storeA)).toEqual([a, b]);
    expect(readComputers(storeB)).toEqual([a, b]);
  });

  it("keeps aliases across refresh, repeated pairing and a round trip", () => {
    const saved = saveComputers([a, b], storage());
    expect(rememberComputer(b.origin, "", saved)).toEqual(saved);
    const renamed = rememberComputer(a.origin, "办公电脑", saved);
    const handoff = readComputerHandoff(new URL(computerNavigation(b.origin, renamed)).hash);
    expect(mergeComputers(saved, handoff.computers)).toEqual([{ ...a, name: "办公电脑" }, b]);
  });

  it("whitelists directory metadata and rejects unsafe addresses", () => {
    expect(normalizeComputers([
      { ...a, token: "device-secret", grant, arbitrary: { auth: "secret" } },
      { origin: "javascript:alert(1)", name: "bad" },
      { origin: "https://user:secret@evil.example", name: "bad" },
      { origin: "https://evil.example/api/run", name: "bad" },
      { origin: "https://evil.example/?token=secret", name: "bad" },
      { origin: "https://evil.example/#secret", name: "bad" },
    ])).toEqual([a]);
    expect(computerNavigation(a.origin, [{ ...a, token: "device-secret" }])).not.toContain("device-secret");
    expect(() => computerNavigation("javascript:alert(1)", [a])).toThrow("电脑地址无效");
    expect(readComputerHandoff("#computers=invalid")).toEqual({ computers: [], name: "" });
    expect(readComputerHandoff("#" + "x".repeat(20_000))).toEqual({ computers: [], name: "" });
  });

  it("accepts both existing QR formats and rejects arbitrary URLs and malformed grants", () => {
    const link = `${b.origin}/pair#pair=${grant}`;
    expect(parsePairingTarget(link).href).toBe(link);
    expect(parsePairingTarget(JSON.stringify({ type: "agentroam-pair", version: 1, server: b.origin, grant })).href).toBe(link);
    for (const raw of [b.origin, link + "&token=secret", link.replace("/pair", "/web"), link.replace(grant, "short"), link.replace("https://", "ftp://"), JSON.stringify({ type: "agentroam-pair", version: 2, server: b.origin, grant })]) {
      expect(() => parsePairingTarget(raw)).toThrow("这不是 AgentRoam");
    }
  });

  it("handles corrupt or unavailable browser storage and bounds the directory", () => {
    const saved = storage(); saved.setItem(COMPUTER_STORAGE_KEY, "corrupt");
    expect(readComputers(saved)).toEqual([]);
    expect(() => saveComputers([a], { setItem: () => { throw new Error("QuotaExceeded"); } } as unknown as Storage)).toThrow("浏览器无法保存");
    const full = Array.from({ length: 20 }, (_, index) => ({ origin: `https://c${index}.example`, name: `电脑 ${index}` }));
    expect(() => rememberComputer(b.origin, b.name, full)).toThrow("最多可添加");
  });
});
