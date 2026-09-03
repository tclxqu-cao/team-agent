import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildCloudflaredArguments, waitForConnectedUrl } from "./cloudflare-provider.js";

describe("buildCloudflaredArguments", () => {
  it("uses HTTP/2 so launchd tunnels do not depend on outbound UDP", () => {
    expect(buildCloudflaredArguments("http://127.0.0.1:3000")).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:3000",
    ]);
  });
});

describe("waitForConnectedUrl", () => {
  it("waits for both the public URL and a registered tunnel connection", async () => {
    const { child, stderr } = fakeChild();
    let resolved = false;
    const ready = waitForConnectedUrl(child, vi.fn(), 100).then((url) => {
      resolved = true;
      return url;
    });

    stderr.write("https://ready.trycloudflare.com\n");
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(resolved).toBe(false);

    stderr.write("INF Registered tunnel ");
    stderr.write("connection connIndex=0 protocol=quic\n");
    await expect(ready).resolves.toBe("https://ready.trycloudflare.com");
  });

  it("supports registration output arriving before the URL", async () => {
    const { child, stdout, stderr } = fakeChild();
    const ready = waitForConnectedUrl(child, vi.fn(), 100);

    stdout.write("INF Registered tunnel connection connIndex=0 protocol=http2\n");
    stderr.write("Visit https://later.trycloudflare.com when ready\n");

    await expect(ready).resolves.toBe("https://later.trycloudflare.com");
  });
});

function fakeChild(): { child: ChildProcess; stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as ChildProcess;
  return { child, stdout, stderr };
}
