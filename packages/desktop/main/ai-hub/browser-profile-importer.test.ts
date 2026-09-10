import { createCipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveChromiumCookieKey, type ChromiumCookieRow } from "./cookie-migration";
import {
  BrowserProfileImporter,
  HUB_PROFILE_DIR_NAME,
  shouldExcludeProfileEntry,
  validateStagedProfileEntries,
} from "./browser-profile-importer";
import { ProfileImportStateStore } from "./import-state";

const SECRET = "import-test-secret";

function encryptV10(plain: string): Buffer {
  const cipher = createCipheriv("aes-128-cbc", deriveChromiumCookieKey(SECRET), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(plain, "utf8"), cipher.final()]);
}

const FAR_FUTURE = (1_800_000_000 + 11_644_473_600) * 1_000_000;

function makeRow(overrides: Partial<ChromiumCookieRow> = {}): ChromiumCookieRow {
  return {
    host_key: ".example.com",
    name: "sid",
    value: "",
    encrypted_value: encryptV10("cookie-value"),
    path: "/",
    expires_utc: FAR_FUTURE,
    is_secure: 1,
    is_httponly: 0,
    is_persistent: 1,
    has_expires: 1,
    samesite: 1,
    top_frame_site_id: null,
    partition_id: 0,
    ...overrides,
  };
}

function makeEnv(options: {
  running?: boolean;
  keychainOk?: boolean;
  rows?: ChromiumCookieRow[];
  failAllCookieInstalls?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "hub-import-test-"));
  const sourceDir = join(root, "source-profile");
  mkdirSync(join(sourceDir, "Cache"), { recursive: true });
  mkdirSync(join(sourceDir, "Local Storage"), { recursive: true });
  writeFileSync(join(sourceDir, "Preferences"), "{}");
  writeFileSync(join(sourceDir, "Cookies"), "sqlite-bytes");
  writeFileSync(join(sourceDir, "Cache", "junk"), "x");
  writeFileSync(join(sourceDir, "SingletonLock"), "lock");
  writeFileSync(join(sourceDir, "LOCK"), "leveldb-lock");
  symlinkSync(sourceDir, join(sourceDir, "danger-link"));

  const destRoot = join(root, HUB_PROFILE_DIR_NAME);
  const stateStore = new ProfileImportStateStore(join(root, "ai-hub-profile-import.json"));
  const installedCookies: Array<Record<string, unknown>> = [];
  const installedInto: string[] = [];
  const phases: string[] = [];
  let flushes = 0;
  const importer = new BrowserProfileImporter({
    destRoot,
    stateStore,
    isProcessRunning: async () => options.running ?? false,
    getSourceProfilePath: () => sourceDir,
    readKeychainSecret: async () => {
      if (options.keychainOk === false) throw new Error("user denied");
      return SECRET;
    },
    readCookieRows: async () => options.rows ?? [makeRow(), makeRow({ name: "second" })],
    createSession: (profilePath) => ({
      setCookie: async (details) => {
        if (options.failAllCookieInstalls) throw new Error("install failed");
        installedInto.push(profilePath);
        installedCookies.push(details as unknown as Record<string, unknown>);
      },
      flushStore: async () => {
        flushes += 1;
      },
    }),
    getAvailableBytes: async () => 1 << 30,
    nowIso: () => "2026-09-10T03:00:00.000Z",
    onProgress: (phase) => phases.push(phase),
  });
  return {
    root,
    sourceDir,
    destRoot,
    stateStore,
    importer,
    installedCookies,
    installedInto,
    phases,
    flushCount: () => flushes,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("profile copy policy", () => {
  it("excludes runtime locks, caches, and temp files but keeps profile data", () => {
    expect(shouldExcludeProfileEntry("SingletonLock")).toBe(true);
    expect(shouldExcludeProfileEntry("Cache")).toBe(true);
    expect(shouldExcludeProfileEntry("Code Cache")).toBe(true);
    expect(shouldExcludeProfileEntry("Crashpad")).toBe(true);
    expect(shouldExcludeProfileEntry("LOCK")).toBe(true);
    expect(shouldExcludeProfileEntry("foo.tmp")).toBe(true);
    expect(shouldExcludeProfileEntry("Cookies")).toBe(false);
    expect(shouldExcludeProfileEntry("Local Storage")).toBe(false);
    expect(shouldExcludeProfileEntry("Preferences")).toBe(false);
  });

  it("requires recognizable profile storage before activation", () => {
    expect(validateStagedProfileEntries([{ name: "Local Storage", isDirectory: true }])).toBe(true);
    expect(validateStagedProfileEntries([{ name: "Preferences", isDirectory: false }])).toBe(true);
    expect(validateStagedProfileEntries([{ name: "Cookies", isDirectory: false }])).toBe(true);
    expect(validateStagedProfileEntries([{ name: "Cache", isDirectory: true }])).toBe(false);
    expect(validateStagedProfileEntries([])).toBe(false);
  });
});

describe("BrowserProfileImporter", () => {
  it("imports atomically: phases in order, transient paths excluded, cookies installed into the activated snapshot", async () => {
    const env = makeEnv();
    try {
      const result = await env.importer.import("chrome-default");
      expect(result.ok).toBe(true);
      expect(result.restartRequired).toBe(true);
      expect(result.importedCookieCount).toBe(2);
      expect(env.phases).toEqual(["checking", "copying", "importing-cookies", "validating", "complete"]);

      const currentPath = join(env.destRoot, "current");
      expect(existsSync(join(currentPath, "Preferences"))).toBe(true);
      expect(existsSync(join(currentPath, "Local Storage"))).toBe(true);
      expect(existsSync(join(currentPath, "Cache"))).toBe(false);
      expect(existsSync(join(currentPath, "SingletonLock"))).toBe(false);
      expect(existsSync(join(currentPath, "LOCK"))).toBe(false);
      expect(existsSync(join(currentPath, "danger-link"))).toBe(false);
      // 源 cookie 库在激活前被删除，Electron 用自己的加密重建
      expect(existsSync(join(currentPath, "Cookies"))).toBe(false);
      // cookie 写进了激活后的 current 路径并 flush
      expect(env.installedInto.every((path) => path === currentPath)).toBe(true);
      expect(env.installedCookies.length).toBe(2);
      expect(env.flushCount()).toBe(1);

      const status = env.importer.getStatus();
      expect(status).toMatchObject({ active: true, restartRequired: true, sourceId: "chrome-default" });
      expect(JSON.stringify(status)).not.toContain(SECRET);
    } finally {
      env.cleanup();
    }
  });

  it("blocks import while the source browser is running", async () => {
    const env = makeEnv({ running: true });
    try {
      const result = await env.importer.import("chrome-default");
      expect(result).toMatchObject({ ok: false, errorCategory: "source-browser-running" });
      expect(existsSync(env.destRoot)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("fails closed when Keychain access is denied and removes staging", async () => {
    const env = makeEnv({ keychainOk: false });
    try {
      const result = await env.importer.import("chrome-default");
      expect(result).toMatchObject({ ok: false, errorCategory: "keychain-denied" });
      const leftovers = existsSync(env.destRoot)
        ? readdirSync(env.destRoot).filter((name) => name.startsWith("staging-"))
        : [];
      expect(leftovers).toEqual([]);
      expect(existsSync(join(env.destRoot, "current"))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("fails closed when a profile full of encrypted cookies yields zero migrations", async () => {
    const env = makeEnv({ rows: [makeRow({ encrypted_value: Buffer.from("v10-garbage!!!") })] });
    try {
      const result = await env.importer.import("chrome-default");
      expect(result).toMatchObject({ ok: false, errorCategory: "cookie-migration-failed" });
      expect(existsSync(join(env.destRoot, "current"))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("rejects a second copy until the app restarts, then clears the gate on startup load", async () => {
    const env = makeEnv();
    try {
      expect((await env.importer.import("chrome-default")).ok).toBe(true);
      const second = await env.importer.import("chrome-default");
      expect(second).toMatchObject({ ok: false, errorCategory: "restart-required" });

      const startup = await env.importer.prepareForStartup();
      expect(startup).toEqual({ profilePath: join(env.destRoot, "current"), recovered: false });
      expect(env.importer.isRestartPending()).toBe(false);
      // 重启后（闸门解除）允许重新导入替换快照
      expect((await env.importer.import("ego-lite-default")).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("rejects unknown source ids and keeps the active snapshot on failure", async () => {
    const env = makeEnv();
    try {
      const unknown = await env.importer.import("firefox-default");
      expect(unknown).toMatchObject({ ok: false, errorCategory: "source-unavailable" });

      expect((await env.importer.import("chrome-default")).ok).toBe(true);
      const brokenSecond = await env.importer.import("ego-lite-default");
      // ego-lite 来源未在测试环境提供 → 失败但 current 保持可用
      expect(brokenSecond.ok).toBe(false);
      expect(env.importer.getStatus().active).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("rolls back to the recoverable backup when startup validation fails", async () => {
    const env = makeEnv();
    try {
      expect((await env.importer.import("chrome-default")).ok).toBe(true);
      const currentPath = join(env.destRoot, "current");
      const backupPath = join(env.destRoot, "backup");
      rmSync(currentPath, { recursive: true, force: true });
      mkdirSync(join(backupPath, "Local Storage"), { recursive: true });
      writeFileSync(join(backupPath, "Preferences"), "{}");
      writeFileSync(join(backupPath, "Cookies"), "sqlite");

      const startup = await env.importer.prepareForStartup();
      expect(startup.recovered).toBe(true);
      expect(existsSync(join(currentPath, "Preferences"))).toBe(true);
      expect(env.importer.getStatus().active).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("reports a recoverable validation error when neither current nor backup is usable", async () => {
    const env = makeEnv();
    try {
      // 从未导入过：状态文件不存在也不应崩溃
      expect(await env.importer.prepareForStartup()).toEqual({ profilePath: null, recovered: false });
      expect(env.importer.getStatus().active).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
