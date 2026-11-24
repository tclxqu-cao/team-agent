import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMeshEnvironment, saveMeshEnvironment } from "./mesh-config.js";
import { parseArgs } from "../args.js";
import { meshMachineId, meshQrPayload } from "./mesh-payload.js";

describe("mesh CLI surface", () => {
  it("requires an explicit mesh action", () => {
    expect(parseArgs(["mesh", "status"])).toMatchObject({ command: "mesh", meshAction: "status" });
    expect(parseArgs(["mesh", "onboard", "--node-name", "macbook-pro"]))
      .toMatchObject({ meshAction: "onboard", meshNodeName: "macbook-pro" });
    expect(() => parseArgs(["mesh"])).toThrow("requires");
    expect(() => parseArgs(["mesh", "join"])).toThrow("requires");
  });

  it("limits mesh options", () => {
    expect(() => parseArgs(["mesh", "status", "--relay", "auto"])).toThrow("accepts only");
    expect(() => parseArgs(["mesh", "onboard", "--node-name", "bad name"])).toThrow("node name");
    expect(() => parseArgs(["mesh", "onboard", "--node-name", "desktop-"])).toThrow("node name");
  });

  it("normalizes machine ids into headscale-safe users", () => {
    expect(meshMachineId("MacBook-Pro.local")).toBe("macbook-pro-local");
    expect(meshMachineId("!!!")).toBe("local");
    expect(meshMachineId("a".repeat(80)).length).toBe(32);
    expect(meshMachineId(`${"a".repeat(31)}.local`)).toBe("a".repeat(31));
  });

  it("encodes the QR payload as a typed, versioned JSON document", () => {
    const payload = JSON.parse(meshQrPayload({ loginServer: "https://hs.example.com", authkey: "tskey-auth-1", expiresAt: "2026-11-23T01:00:00Z" }));
    expect(payload).toEqual({
      type: "agentroam-mesh",
      version: 1,
      loginServer: "https://hs.example.com",
      authkey: "tskey-auth-1",
      expiresAt: "2026-11-23T01:00:00Z",
    });
    expect(JSON.parse(meshQrPayload({ loginServer: "http://100.64.0.1:8080", authkey: "k" }))).not.toHaveProperty("expiresAt");
  });
});

it("preserves private Headscale configuration across background service launches", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mesh-config-"));
  try {
    const env = { AGENT_HEADSCALE_URL: "https://mesh.example.test", AGENT_HEADSCALE_API_KEY: "fixture-key" };
    await expect(loadMeshEnvironment(dataDir, {})).resolves.toEqual({});
    await expect(saveMeshEnvironment(dataDir, { AGENT_HEADSCALE_URL: env.AGENT_HEADSCALE_URL })).rejects.toThrow("同时设置");
    await saveMeshEnvironment(dataDir, env);
    await expect(loadMeshEnvironment(dataDir, {})).resolves.toEqual(env);
    await expect(loadMeshEnvironment(dataDir, { ...env, AGENT_HEADSCALE_API_KEY: "override" })).resolves.toEqual({});
    if (process.platform !== "win32") expect((await stat(join(dataDir, "mesh", "control-plane.json"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
