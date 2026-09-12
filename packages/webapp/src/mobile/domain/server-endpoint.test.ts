import { describe, expect, it } from "vitest";
import { ServerEndpoint } from "./server-endpoint";

describe("ServerEndpoint", () => {
  it("normalizes user input into a bare origin", () => {
    expect(ServerEndpoint.parse("http://192.168.1.10:3000/")?.toString()).toBe("http://192.168.1.10:3000");
    expect(ServerEndpoint.parse("  HTTPS://AgentRoam.local:3000/app?q=1 ")?.toString()).toBe("https://agentroam.local:3000");
    expect(ServerEndpoint.parse("192.168.1.10:3000")?.toString()).toBe("http://192.168.1.10:3000");
  });

  it("rejects non-http schemes and garbage", () => {
    expect(ServerEndpoint.parse("ftp://192.168.1.10")).toBeNull();
    expect(ServerEndpoint.parse("javascript:alert(1)")).toBeNull();
    expect(ServerEndpoint.parse("not a url ::://")).toBeNull();
    expect(ServerEndpoint.parse("")).toBeNull();
  });

  it("joins api paths without double slashes", () => {
    const endpoint = ServerEndpoint.parse("http://10.0.0.2:3000");
    expect(endpoint?.api("/api/agent/model")).toBe("http://10.0.0.2:3000/api/agent/model");
    expect(endpoint?.api("api/agent/model")).toBe("http://10.0.0.2:3000/api/agent/model");
  });
});
