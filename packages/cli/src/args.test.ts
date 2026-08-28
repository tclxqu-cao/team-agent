import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("uses auto relay and the current directory by default", () => {
    const value = parseArgs([]);
    expect(value.command).toBe("start");
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
});
