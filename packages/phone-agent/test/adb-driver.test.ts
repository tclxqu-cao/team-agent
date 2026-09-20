import { describe, expect, it } from "vitest";
import { AdbDriver, type SpawnFn, type SpawnResult } from "../src/drivers/adb.js";

function fakeSpawn(handler: (file: string, args: string[]) => SpawnResult | Promise<SpawnResult>): {
  fn: SpawnFn;
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fn: SpawnFn = async (file, args) => {
    calls.push({ file, args });
    return handler(file, args);
  };
  return { fn, calls };
}

const okText = (stdout: string): SpawnResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: "" });

describe("AdbDriver", () => {
  it("探测可用 adb 并缓存", async () => {
    const { fn, calls } = fakeSpawn((file, args) =>
      args[0] === "version" ? okText("Android Debug Bridge version 1.0.41") : okText(""),
    );
    const driver = new AdbDriver({ spawnFn: fn });
    const status = await driver.status();
    expect(status.ok).toBe(true);
    expect(calls[0].args[0]).toBe("version");
  });

  it("全部候选都不可用时给出安装提示", async () => {
    const { fn } = fakeSpawn(() => ({ code: -1, stdout: Buffer.alloc(0), stderr: "not found" }));
    const driver = new AdbDriver({ spawnFn: fn });
    const status = await driver.status();
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/找不到 adb/);
  });

  it("tap 发送正确参数（含 -s 序列号）", async () => {
    const { fn, calls } = fakeSpawn((file, args) =>
      args[0] === "version" ? okText("ok") : okText(""),
    );
    const driver = new AdbDriver({ spawnFn: fn, serial: "emu-5554" });
    await driver.tap(120, 340);
    const tap = calls.find((c) => c.args.includes("tap"))!;
    expect(tap.args).toEqual(["-s", "emu-5554", "shell", "input", "tap", "120", "340"]);
  });

  it("inputText 转义空格、拒绝非 ASCII", async () => {
    const { fn, calls } = fakeSpawn((_f, args) => (args[0] === "version" ? okText("ok") : okText("")));
    const driver = new AdbDriver({ spawnFn: fn });
    await driver.inputText("airpods pro 2");
    const text = calls.find((c) => c.args.includes("text"))!;
    expect(text.args[text.args.length - 1]).toBe("airpods%spro%s2");
    await expect(driver.inputText("iPhone 15Pro 手机")).rejects.toThrow(/ASCII/);
  });

  it("screenSize 优先 Override size", async () => {
    const { fn } = fakeSpawn((_f, args) =>
      args.includes("wm") ? okText("Physical size: 1080x2400\nOverride size: 1080x2340") : okText(""),
    );
    const driver = new AdbDriver({ spawnFn: fn });
    const size = await driver.screenSize();
    expect(size).toEqual({ width: 1080, height: 2340 });
  });

  it("currentApp 解析 mResumedActivity", async () => {
    const { fn } = fakeSpawn((_f, args) =>
      args.includes("activities")
        ? okText("  mResumedActivity: ActivityRecord{1234 u0 com.taobao.taobao/com.taobao.tao.TbMainActivity} t123")
        : okText(""),
    );
    const driver = new AdbDriver({ spawnFn: fn });
    expect(await driver.currentApp()).toBe("com.taobao.taobao");
  });

  it("launchApp 优先 resolve-activity + am start", async () => {
    const { fn, calls } = fakeSpawn((_f, args) => {
      if (args[0] === "version") return okText("ok");
      if (args.includes("resolve-activity")) return okText("priority=0 preferredOrder=0\n  com.android.settings/.Settings\n");
      return okText("");
    });
    const driver = new AdbDriver({ spawnFn: fn });
    await driver.launchApp("com.android.settings");
    const am = calls.find((c) => c.args.includes("am"))!;
    expect(am.args).toEqual(["shell", "am", "start", "-n", "com.android.settings/.Settings"]);
    expect(calls.some((c) => c.args.includes("monkey"))).toBe(false);
  });

  it("launchApp resolve 失败时回退 monkey", async () => {
    const { fn, calls } = fakeSpawn((_f, args) =>
      args[0] === "version" ? okText("ok") : okText(""),
    );
    const driver = new AdbDriver({ spawnFn: fn });
    await driver.launchApp("com.jingdong.app.mall");
    const monkey = calls.find((c) => c.args.includes("monkey"))!;
    expect(monkey.args).toContain("com.jingdong.app.mall");
  });

  it("screenshot 返回 PNG 字节", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fn } = fakeSpawn((_f, args) =>
      args.includes("screencap")
        ? { code: 0, stdout: png, stderr: "" }
        : okText(""),
    );
    const driver = new AdbDriver({ spawnFn: fn });
    const out = await driver.screenshot();
    expect(Buffer.from(out).equals(png)).toBe(true);
  });
});
