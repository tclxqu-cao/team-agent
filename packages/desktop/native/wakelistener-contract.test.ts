import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The contract test drives the real toolchain. When the host's swiftc is
// broken (e.g. the known CommandLineTools bug where a stale
// usr/include/swift/module.modulemap redefines SwiftBridging), fail fast
// with a clear skip instead of a cryptic compile wall — a healthy CLT/Xcode
// still runs the full test.
function swiftcUsable(): boolean {
  const probe = join(mkdtempSync(join(tmpdir(), "swiftc-probe-")), "probe.swift");
  writeFileSync(probe, 'import Foundation\nlet _ = ProcessInfo.processInfo\n');
  const result = spawnSync("swiftc", ["-o", probe.replace(/\.swift$/, ".o"), "-c", probe], { timeout: 60_000 });
  return result.status === 0;
}

describe("wakelistener external ASR contract", () => {
  it("emits only 16 kHz mono float32 PCM on stdout and controls on stderr", (ctx) => {
    if (!swiftcUsable()) {
      ctx.skip();
      return;
    }
    const source = new URL("./wakelistener.swift", import.meta.url).pathname;
    const binary = join(mkdtempSync(join(tmpdir(), "wakelistener-")), "wakelistener");
    execFileSync("swiftc", [
      "-swift-version", "5",
      "-O",
      "-framework", "Speech",
      "-framework", "AVFoundation",
      source,
      "-o", binary,
    ]);

    const result = spawnSync(binary, ["zh-CN", "--pcm-self-test"], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });

    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe("READY pcm-self-test\n");
    expect(result.stdout.length).toBeGreaterThan(4_000);
    expect(result.stdout.length).toBeLessThan(8_000);
    expect(result.stdout.length % Float32Array.BYTES_PER_ELEMENT).toBe(0);
    for (let offset = 0; offset < result.stdout.length; offset += 4) {
      expect(Number.isFinite(result.stdout.readFloatLE(offset))).toBe(true);
    }
  }, 15_000);
});
