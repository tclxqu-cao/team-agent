import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("uses auto relay and the current directory by default", () => {
    const value = parseArgs([]);
    expect(value.command).toBe("start");
    expect(value.serviceAction).toBeNull();
    expect(value.roots).toEqual([process.cwd()]);
    expect(value.relay).toBe("auto");
  });

  it("parses every supported relay", () => {
    expect(parseArgs(["--relay", "cloudflare"]).relay).toBe("cloudflare");
    expect(parseArgs(["--relay", "pinggy"]).relay).toBe("pinggy");
    expect(parseArgs(["--relay", "custom", "--tunnel-command", "relay {port}"]).relay).toBe("custom");
  });

  it("parses repeatable roots and custom relay options", () => {
    const value = parseArgs([
      "start", "--root", ".", "--root", "..", "--relay", "custom", "--tunnel-command", "relay {port}", "--no-qr",
    ]);
    expect(value.roots).toHaveLength(2);
    expect(value.tunnelCommand).toContain("{port}");
    expect(value.qr).toBe(false);
  });

  it("rejects invalid ports and relay names", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow();
    expect(() => parseArgs(["--relay", "unknown"])).toThrow("relay must be auto");
  });

  it("parses every service action", () => {
    for (const action of ["install", "start", "stop", "status", "url", "logs", "restart", "uninstall"] as const) {
      const value = parseArgs(["service", action]);
      expect(value.command).toBe("service");
      expect(value.serviceAction).toBe(action);
    }
  });

  it("parses service install using the existing start options", () => {
    const value = parseArgs([
      "service", "install", "--root", ".", "--root", "..", "--port", "3210", "--relay", "cloudflare",
      "--data-dir", "./service-data", "--no-qr",
    ]);
    expect(value.roots).toHaveLength(2);
    expect(value.port).toBe(3210);
    expect(value.relay).toBe("cloudflare");
    expect(value.dataDir).toBe(resolve(process.cwd(), "service-data"));
    expect(value.qr).toBe(false);
  });

  it("rejects missing service actions and options on non-install actions", () => {
    expect(() => parseArgs(["service"])).toThrow("service requires");
    expect(() => parseArgs(["service", "unknown"])).toThrow("service requires");
    expect(() => parseArgs(["service", "status", "--root", "."])).toThrow("does not accept options");
    expect(() => parseArgs(["service", "start", "--port", "3000"])).toThrow("does not accept options");
    expect(() => parseArgs(["service", "stop", "--local-only"])).toThrow("does not accept options");
  });

  it("parses update with an optional exact stable version", () => {
    expect(parseArgs(["update"]).updateVersion).toBeNull();
    expect(parseArgs(["update", "1.2.3", "--data-dir", "./data"])).toMatchObject({ command: "update", updateVersion: "1.2.3" });
    expect(() => parseArgs(["update", "1.2.3-preview.1"])).toThrow("exact stable");
  });
});
