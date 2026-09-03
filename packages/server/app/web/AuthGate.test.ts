import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionElapsedSeconds } from "./AuthGate";

const source = readFileSync(new URL("./AuthGate.tsx", import.meta.url), "utf8");

describe("remote console auth gate", () => {
  it("shows a computer icon and live connection duration", () => {
    expect(source).toContain('import { Monitor } from "lucide-react"');
    expect(source).toContain('auth.error || "远程连接中"');
    expect(source).toContain("· 已持续 {connectionElapsedSeconds(startedAt, now)} 秒");
    expect(source).toContain("window.setInterval(() => setNow(Date.now()), 1_000)");
    expect(source).toContain("backdrop-filter: blur(8px) saturate(1.12)");
    expect(source).toContain("-webkit-backdrop-filter: blur(8px) saturate(1.12)");
  });

  it("renders a restrained 3D connection scene with reduced-motion support", () => {
    expect(source).toContain('className="remote-grid"');
    expect(source).toContain('className="remote-device"');
    expect(source).toContain('className="remote-screen-scan"');
    expect(source).toContain("perspective: 520px");
    expect(source).toContain("@keyframes signalPulse");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("reports whole non-negative elapsed seconds", () => {
    expect(connectionElapsedSeconds(1_000, 4_999)).toBe(3);
    expect(connectionElapsedSeconds(4_000, 1_000)).toBe(0);
  });
});
