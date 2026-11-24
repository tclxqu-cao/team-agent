import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error gateway ESM
import { createMeshService, meshUserFor } from "./mesh-service.mjs";

describe("mesh service", () => {
  it("maps a machine id to a stable headscale user", () => {
    expect(meshUserFor("macbook-pro")).toBe("agentroam-macbook-pro");
    expect(meshUserFor("MAC Book.local")).toBe(meshUserFor("MAC Book.local"));
    expect(meshUserFor("MAC Book.local")).toMatch(/^agentroam-[a-z0-9-]{1,32}$/);
    expect(meshUserFor("x".repeat(80)).length).toBeLessThanOrEqual(63);
  });

  it("reports unconfigured without control plane env", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mesh-service-"));
    try {
      const service = createMeshService({ dataDir, env: {} });
      const status = await service.status();
      expect(status.configured).toBe(false);
      expect(status.phase).toBe("unconfigured");
      await expect(service.listNodes()).rejects.toThrow(/AGENT_HEADSCALE_URL/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("mints a one-time key against the headscale v1 API and persists joined state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mesh-service-"));
    const calls: { url: string; body: unknown }[] = [];
    const request = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith("/api/v1/user")) return Response.json({ user: { id: "42" } });
      if (url.endsWith("/api/v1/preauthkey")) {
        return new Response(JSON.stringify({ preAuthKey: { key: "tskey-auth-test", expiration: "2026-11-23T01:00:00Z" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    try {
      const service = createMeshService({
        dataDir,
        env: { AGENT_HEADSCALE_URL: "https://headscale.example.com/", AGENT_HEADSCALE_API_KEY: "key" },
        request: request as unknown as typeof fetch,
      });
      const issued = await service.mintNodeKey({ machineId: "macbook", nodeName: "desktop" });
      expect(issued.loginServer).toBe("https://headscale.example.com");
      expect(issued.authkey).toBe("tskey-auth-test");
      expect(issued.user).toMatch(/^agentroam-[0-9a-f]{24}$/);
      expect(calls[0]?.url).toBe("https://headscale.example.com/api/v1/user");
      expect(calls[0]?.body).toMatchObject({ name: issued.user });
      expect(calls[1]?.body).toMatchObject({ user: "42", reusable: false, ephemeral: false });

      await service.markJoined({ hostname: "desktop", tailnetIPv4: "100.64.0.2", dnsName: "desktop.ts.example.com", user: "agentroam-macbook" });
      const status = await service.status();
      expect(status.phase).toBe("joined");
      expect(status.tailnetIPv4).toBe("100.64.0.2");
      const persisted = await readFile(join(dataDir, "mesh", "state.json"), "utf8");
      expect(persisted).toContain("100.64.0.2");
      expect(persisted).not.toContain("key");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("treats an existing headscale user as success (idempotent onboarding)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mesh-service-"));
    const request = vi.fn(async (url: string) => {
      if (url.includes("?name=")) return Response.json({ users: [{ name: new URL(url).searchParams.get("name"), id: "42" }] });
      if (url.endsWith("/api/v1/user")) return new Response(JSON.stringify({ message: "user already exists" }), { status: 409 });
      return new Response(JSON.stringify({ preAuthKey: { key: "k" } }), { status: 200 });
    });
    try {
      const service = createMeshService({
        dataDir,
        env: { AGENT_HEADSCALE_URL: "https://hs.example.com", AGENT_HEADSCALE_API_KEY: "key" },
        request: request as unknown as typeof fetch,
      });
      await expect(service.mintNodeKey({ machineId: "m", nodeName: "n" })).resolves.toMatchObject({ authkey: "k" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
