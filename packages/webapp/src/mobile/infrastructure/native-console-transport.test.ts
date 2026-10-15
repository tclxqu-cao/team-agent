import { describe, expect, it, vi } from "vitest";
import { createNativeConsoleFetch, nativeWorkspaceFrameUrl } from "./native-console-transport";

describe("native console transport", () => {
  it("routes API calls and Request bodies to the selected server while keeping bundled assets local", async () => {
    const authorized = vi.fn(async () => Response.json({ ok: true }));
    const fallback = vi.fn(async () => new Response("asset"));
    const fetch = createNativeConsoleFetch("https://computer.example", "https://localhost", { fetch: authorized }, fallback);
    await fetch("/api/web-console/bootstrap");
    expect(String(authorized.mock.calls[0][0])).toBe("https://computer.example/api/web-console/bootstrap");
    const request = new Request("https://localhost/api/web-console/preferences", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    await fetch(request);
    const forwarded = authorized.mock.calls[1][0] as Request;
    expect(forwarded.url).toBe("https://computer.example/api/web-console/preferences");
    expect(forwarded.method).toBe("POST"); expect(await forwarded.text()).toBe("{}");
    await fetch("/assets/App.js");
    await fetch("https://another.example/api/settings");
    expect(authorized).toHaveBeenCalledTimes(2); expect(fallback).toHaveBeenCalledTimes(2);
  });
  it("builds local frames for each shared view without propagating a grant or boot parameters", () => {
    const frame = new URL(nativeWorkspaceFrameUrl("/app/?view=collaboration&groupId=group-1", "capacitor://localhost/index.html?server=old#pair=secret"));
    expect(frame.protocol).toBe("capacitor:"); expect(frame.pathname).toBe("/index.html");
    expect(frame.searchParams.get("view")).toBe("collaboration");
    expect(frame.searchParams.get("groupId")).toBe("group-1");
    expect(frame.searchParams.get("workspace")).toBe("1");
    expect(frame.searchParams.has("server")).toBe(false); expect(frame.hash).toBe("");
  });
  it("routes iOS custom-scheme APIs without authorizing other opaque origins", async () => {
    const authorized = vi.fn(async () => new Response("ok"));
    const fallback = vi.fn(async () => new Response("asset"));
    const fetch = createNativeConsoleFetch("https://computer.example", "capacitor://localhost/index.html", { fetch: authorized }, fallback);
    await fetch("/api/web-auth/status");
    expect(String(authorized.mock.calls[0][0])).toBe("https://computer.example/api/web-auth/status");
    await fetch("capacitor://untrusted/api/web-auth/status");
    expect(authorized).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
