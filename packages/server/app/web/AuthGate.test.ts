import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionElapsedSeconds } from "./AuthGate";

const source = readFileSync(new URL("./AuthGate.tsx", import.meta.url), "utf8");
const bootCss = readFileSync(new URL("./neural-boot.css", import.meta.url), "utf8");

describe("remote console auth gate", () => {
  it("keeps one digital-human boot surface across auth and workspace hydration", () => {
    expect(source).toContain('import { Bot, RefreshCw } from "lucide-react"');
    expect(source).toContain("正在唤醒工作区");
    expect(source).toContain('auth.error || "数字人核心正在就绪"');
    expect(source).toContain("<span>AGENT CORE</span>");
    expect(source).toContain("children(auth, markWorkspaceReady)");
    expect(source).toContain('className={`neural-boot${ready ? " is-ready" : ""}');
    expect(source).not.toContain("远程连接中");
    expect(source).not.toContain("正在同步会话与工具");
    expect(source).not.toContain("正在建立安全连接");
  });

  it("renders a neural portrait with stable dimensions and reduced-motion support", () => {
    expect(source).toContain('className="neural-portrait"');
    expect(source).toContain('className="neural-avatar-frame"');
    expect(source).toContain('className="neural-progress"');
    expect(bootCss).toContain("width: 232px");
    expect(bootCss).toContain("@keyframes neural-orbit");
    expect(bootCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("reports whole non-negative elapsed seconds", () => {
    expect(connectionElapsedSeconds(1_000, 4_999)).toBe(3);
    expect(connectionElapsedSeconds(4_000, 1_000)).toBe(0);
  });
});
