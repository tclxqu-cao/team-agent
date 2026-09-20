import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppEntry, DriverStatus, PhoneDriver, PressKey, ScreenSize } from "./types.js";

export interface SpawnResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** 可注入的 execFile 封装，测试用 fake 替换。 */
export type SpawnFn = (
  file: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
) => Promise<SpawnResult>;

export const defaultSpawn: SpawnFn = (file, args, timeoutMs, maxBuffer) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer, encoding: "buffer" },
      (err, stdout, stderr) => {
        // 非零退出时 execFile 给 err（含 code），stdout/stderr 仍可用
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
          ? (err as unknown as { code: number }).code
          : err ? -1 : 0;
        if (err && code === -1 && stdout.length === 0) {
          reject(err);
          return;
        }
        resolve({ code, stdout: stdout as Buffer, stderr: String(stderr ?? "") });
      },
    );
  });

const KEY_CODES: Record<PressKey, number> = {
  back: 4,
  home: 3,
  enter: 66,
  recent: 187,
};

/** Android 常见 adb 二进制位置（PATH 之外）。 */
const ADB_FALLBACKS = [
  join(homedir(), "Library/Android/sdk/platform-tools/adb"),
  "/usr/local/bin/adb",
  "/opt/homebrew/bin/adb",
];

export class AdbDriver implements PhoneDriver {
  readonly kind = "adb" as const;
  private readonly spawnFn: SpawnFn;
  private readonly adbOverride: string;
  private readonly serial: string;
  private adbPathCache: string | null = null;

  constructor(opts: { adbPath?: string; serial?: string; spawnFn?: SpawnFn } = {}) {
    this.adbOverride = opts.adbPath ?? "";
    this.serial = opts.serial ?? "";
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }

  private async adb(): Promise<string> {
    if (this.adbPathCache) return this.adbPathCache;
    const candidates = [
      ...(this.adbOverride ? [this.adbOverride] : []),
      "adb",
      ...ADB_FALLBACKS,
    ];
    for (const candidate of candidates) {
      try {
        const r = await this.spawnFn(candidate, ["version"], 5000, 1024 * 64);
        if (r.code === 0) {
          this.adbPathCache = candidate;
          return candidate;
        }
      } catch {
        // 试下一个候选
      }
    }
    throw new Error(
      "找不到 adb。请安装 Android platform-tools，或设置 PHONE_ADB_PATH 指向 adb 二进制。",
    );
  }

  private async run(args: string[], timeoutMs = 15_000): Promise<string> {
    const adb = await this.adb();
    const full = this.serial ? ["-s", this.serial, ...args] : args;
    const r = await this.spawnFn(adb, full, timeoutMs, 32 * 1024 * 1024);
    if (r.code !== 0) {
      throw new Error(`adb ${args[0]} 失败(code=${r.code}): ${r.stderr.trim() || r.stdout.toString().trim()}`);
    }
    return r.stdout.toString("utf8");
  }

  async status(): Promise<DriverStatus> {
    try {
      const adb = await this.adb();
      const out = await this.run(["shell", "getprop", "ro.product.model"], 8000);
      const model = out.trim() || "unknown";
      const serial = this.serial || "(default)";
      return { ok: true, detail: `Android ${model} (${serial}) via ${adb}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async screenSize(): Promise<ScreenSize> {
    const out = await this.run(["shell", "wm", "size"]);
    // 优先 Override size（分屏/缩放时的真实可用尺寸），否则 Physical size
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
    if (!m) throw new Error(`无法解析 wm size 输出: ${out.trim()}`);
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  async screenshot(): Promise<Uint8Array> {
    const adb = await this.adb();
    const full = this.serial ? ["-s", this.serial, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"];
    const r = await this.spawnFn(adb, full, 20_000, 64 * 1024 * 1024);
    if (r.code !== 0 || r.stdout.length === 0) {
      throw new Error(`screencap 失败(code=${r.code}): ${r.stderr.trim()}`);
    }
    return new Uint8Array(r.stdout);
  }

  async uiTreeXml(): Promise<string> {
    const dump = async () => {
      await this.run(["shell", "uiautomator", "dump", "/sdcard/phone-agent-uidump.xml"], 20_000);
      return this.run(["shell", "cat", "/sdcard/phone-agent-uidump.xml"], 10_000);
    };
    try {
      return await dump();
    } catch (first) {
      // 页面动画中常见 "could not get idle state"，等 800ms 重试一次
      await new Promise((r) => setTimeout(r, 800));
      try {
        return await dump();
      } catch {
        throw first;
      }
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.run(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.run([
      "shell", "input", "swipe",
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(Math.max(50, Math.round(durationMs))),
    ]);
  }

  async inputText(text: string): Promise<void> {
    if (!/^[\x20-\x7E]*$/.test(text)) {
      throw new Error(
        "Android input 命令只支持 ASCII。中文输入请在 iOS(WDA) 上使用，或在安卓上安装 ADBKeyboard 后扩展本驱动。",
      );
    }
    // input text 把空格当参数分隔，约定 %s 转义
    const escaped = text.replace(/ /g, "%s");
    await this.run(["shell", "input", "text", escaped]);
  }

  async pressKey(key: PressKey): Promise<void> {
    await this.run(["shell", "input", "keyevent", String(KEY_CODES[key])]);
  }

  async launchApp(appId: string): Promise<void> {
    // 优先 resolve-activity + am start（确定性启动）；monkey 在部分模拟器/ROM 上会失败
    try {
      const out = await this.run([
        "shell", "cmd", "package", "resolve-activity", "--brief",
        "-c", "android.intent.category.LAUNCHER", appId,
      ]);
      const component = out.trim().split("\n").map((l) => l.trim()).filter((l) => l.includes("/")).pop();
      if (component) {
        await this.run(["shell", "am", "start", "-n", component]);
        return;
      }
    } catch {
      // 落到 monkey
    }
    await this.run([
      "shell", "monkey", "-p", appId,
      "-c", "android.intent.category.LAUNCHER", "1",
    ]);
  }

  async listApps(): Promise<AppEntry[]> {
    const out = await this.run(["shell", "pm", "list", "packages", "-3"], 20_000);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("package:"))
      .map((l) => ({ id: l.slice("package:".length), name: "" }));
  }

  async currentApp(): Promise<string> {
    const out = await this.run(["shell", "dumpsys", "activity", "activities"], 15_000);
    const m =
      /(?:topResumedActivity|mResumedActivity|ResumedActivity)[^\n]*?\s([\w.]+)\//i.exec(out) ??
      null;
    if (m) return m[1];
    const win = await this.run(["shell", "dumpsys", "window"], 15_000);
    const f = /mCurrentFocus=[^\n]*?\s([\w.]+)\//.exec(win);
    if (f) return f[1];
    return "unknown";
  }

  /** 仅在 PHONE_ALLOW_SHELL=1 时由工具层调用。 */
  async shell(command: string): Promise<string> {
    return this.run(["shell", ...command.split(/\s+/)], 30_000);
  }
}
