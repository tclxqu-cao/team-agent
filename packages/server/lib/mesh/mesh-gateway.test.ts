import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
// @ts-expect-error gateway ESM
import { createMeshGateway } from "./mesh-gateway.mjs";

interface RequestFixture {
  address?: string;
  deviceId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  method?: string;
}
function request({ address = "127.0.0.1", deviceId, headers = {}, body = null, method = "POST" }: RequestFixture = {}) {
  const stream = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    method,
    url: "/api/mesh/status",
    socket: { remoteAddress: address },
    headers: {
      "content-type": "application/json",
      ...(deviceId ? { "x-agentroam-device-id": deviceId } : {}),
      ...headers,
    },
  });
}

function response() {
  const state = { status: 0, body: "" };
  return {
    state,
    writeHead(status: number) { state.status = status; },
    end(body?: string) { state.body = body ?? ""; },
  };
}

function meshServiceStub(overrides = {}) {
  return {
    configured: true,
    controlPlaneUrl: "https://hs.example.com",
    status: vi.fn(async () => ({ configured: true, phase: "joined", dnsName: "desk.mesh.test", tailnetIPv4: "100.64.0.2", controlPlaneUrl: "https://hs.example.com" })),
    mintNodeKey: vi.fn(async () => ({ loginServer: "https://hs.example.com", authkey: "tskey-x", expiresAt: null, user: "agentroam-m1", nodeName: "desktop" })),
    listNodes: vi.fn(async () => []),
    deleteNode: vi.fn(async () => undefined),
    markJoined: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined),
    writeState: vi.fn(async () => undefined),
    ...overrides,
  };
}

const desktopHeaders = { "x-agentroam-desktop-token": "fixture-token" };
const authenticateDesktop = (req: ReturnType<typeof request>) => req.headers["x-agentroam-desktop-token"] === "fixture-token";

describe("mesh gateway boundaries", () => {
  it("rejects status before pairing", async () => {
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service: meshServiceStub() });
    const res = response();
    const handled = await gateway.handle(request({ method: "GET" }), res as never);
    expect(handled).toBe(true);
    expect(res.state.status).toBe(401);
  });

  it("returns status for a paired device", async () => {
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service: meshServiceStub() });
    const res = response();
    await gateway.handle(request({ deviceId: "device-1", method: "GET" }), res as never);
    expect(res.state.status).toBe(200);
    expect(JSON.parse(res.state.body).phase).toBe("joined");
  });

  it("refuses to mint keys from a non-loopback caller even with a device id", async () => {
    const service = meshServiceStub();
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service });
    const res = response();
    const req = request({ address: "192.168.1.20", deviceId: "device-1" });
    req.url = "/api/mesh/admin/key";
    await gateway.handle(req, res as never);
    expect(res.state.status).toBe(403);
    expect(service.mintNodeKey).not.toHaveBeenCalled();
  });

  it("requires a desktop credential for paired devices arriving over loopback", async () => {
    const service = meshServiceStub();
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service });
    const req = request({ deviceId: "phone-device", body: { device: "desktop" } });
    req.url = "/api/mesh/admin/key";
    const res = response();
    await gateway.handle(req, res as never);
    expect(res.state.status).toBe(403);
    expect(service.mintNodeKey).not.toHaveBeenCalled();
  });

  it("refuses loopback admin calls that arrived through a proxy", async () => {
    const service = meshServiceStub();
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service });
    const res = response();
    const req = request({ address: "127.0.0.1", deviceId: "desktop", headers: { ...desktopHeaders, "x-forwarded-for": "203.0.113.9" } });
    req.url = "/api/mesh/admin/key";
    await gateway.handle(req, res as never);
    expect(res.state.status).toBe(403);
  });

  it("mints a phone key for a paired device through /api/mesh/join", async () => {
    const service = meshServiceStub();
    const audit = vi.fn();
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service, audit });
    const res = response();
    const req = request({ deviceId: "device-1", body: { nodeName: "phone" } });
    req.url = "/api/mesh/join";
    await gateway.handle(req, res as never);
    expect(res.state.status).toBe(200);
    const payload = JSON.parse(res.state.body);
    expect(payload).toMatchObject({ loginServer: "https://hs.example.com", authkey: "tskey-x", accessUrl: "http://desk.mesh.test" });
    expect(service.mintNodeKey).toHaveBeenCalledWith(expect.objectContaining({ nodeName: "phone" }));
    expect(audit).toHaveBeenCalledWith("mesh.join", "device-1", "success");
  });

  it("returns 503 when the control plane is not configured", async () => {
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service: meshServiceStub({ configured: false }) });
    const res = response();
    const req = request({ deviceId: "device-1", body: {} });
    req.url = "/api/mesh/join";
    await gateway.handle(req, res as never);
    expect(res.state.status).toBe(503);
  });

  it("lets the local CLI mint a desktop key over loopback", async () => {
    const service = meshServiceStub();
    const audit = vi.fn();
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service, audit });
    const res = response();
    const req = request({ address: "127.0.0.1", headers: desktopHeaders, body: { device: "desktop", nodeName: "desktop" } });
    req.url = "/api/mesh/admin/key";
    await gateway.handle(req, res as never);
    expect(res.state.status).toBe(200);
    expect(service.mintNodeKey).toHaveBeenCalledWith(expect.objectContaining({ nodeName: "desktop" }));
    expect(audit).toHaveBeenCalledWith("mesh.key", "desktop", "success");
  });

  it("ignores non-mesh paths", async () => {
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service: meshServiceStub() });
    const res = response();
    const req = request({ deviceId: "device-1", method: "GET" });
    req.url = "/api/agent/model";
    expect(await gateway.handle(req, res as never)).toBe(false);
  });

  it("writes joined state only through loopback", async () => {
    const service = meshServiceStub();
    const gateway = createMeshGateway({ authenticateDesktop, dataDir: "/tmp/unused", service });
    const res = response();
    const req = request({ address: "127.0.0.1", headers: desktopHeaders, body: { hostname: "desktop", tailnetIPv4: "100.64.0.2", dnsName: "desk.mesh.test" } });
    req.url = "/api/mesh/admin/report";
    await gateway.handle(req, res as never);
    expect(service.markJoined).toHaveBeenCalledWith(expect.objectContaining({ hostname: "desktop", tailnetIPv4: "100.64.0.2" }));
  });
});
