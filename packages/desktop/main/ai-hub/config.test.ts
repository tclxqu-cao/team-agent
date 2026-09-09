import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubConfigStore, PRESET_SITES, defaultHubConfig, newCustomSiteId, normalizeHubConfig } from "./config";

describe("normalizeHubConfig", () => {
  it("预设原样通过", () => {
    const config = normalizeHubConfig(defaultHubConfig());
    expect(config.version).toBe(1);
    expect(config.sites).toEqual(PRESET_SITES);
  });

  it("丢弃非法条目：非对象、缺 URL、非 http(s)", () => {
    const config = normalizeHubConfig({
      sites: [null, "x", { name: "a" }, { name: "b", url: "javascript:alert(1)" }, { name: "ok", url: "http://a.com" }],
    });
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0]).toMatchObject({ name: "ok", url: "http://a.com" });
  });

  it("缺 name 用 hostname，缺 id 生成 custom- 前缀，adapter 白名单校验", () => {
    const config = normalizeHubConfig({
      sites: [
        { url: "https://example.com/path", adapter: "not-a-real-adapter" },
        { id: "mine", name: "  我的站点  ", url: "https://b.com", icon: "data:image/png;base64,xx", adapter: "generic" },
      ],
    });
    expect(config.sites[0].name).toBe("example.com");
    expect(config.sites[0].id).toMatch(/^custom-/);
    expect(config.sites[0].adapter).toBeUndefined();
    expect(config.sites[1]).toEqual({ id: "mine", name: "我的站点", url: "https://b.com", icon: "data:image/png;base64,xx", adapter: "generic" });
  });

  it("id 冲突时重新生成，保证唯一", () => {
    const config = normalizeHubConfig({ sites: [{ id: "dup", name: "a", url: "https://a.com" }, { id: "dup", name: "b", url: "https://b.com" }] });
    const ids = config.sites.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("dup");
  });

  it("坏输入 / 空 sites 回退默认配置", () => {
    expect(normalizeHubConfig(null)).toEqual(defaultHubConfig());
    expect(normalizeHubConfig({ sites: [] })).toEqual(defaultHubConfig());
    expect(normalizeHubConfig({ sites: [{ url: "nope" }] })).toEqual(defaultHubConfig());
  });

  it("name 截断到 40 字符", () => {
    const config = normalizeHubConfig({ sites: [{ name: "x".repeat(60), url: "https://a.com" }] });
    expect(config.sites[0].name).toHaveLength(40);
  });
});

describe("HubConfigStore", () => {
  const makeDir = () => mkdtempSync(join(tmpdir(), "ai-hub-config-"));
  const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

  it("首次加载写入默认配置且不算损坏", () => {
    const dir = makeDir();
    try {
      const store = new HubConfigStore(join(dir, "nested", "ai-hub-config.json"));
      const { config, resetFromCorruption } = store.loadSync();
      expect(resetFromCorruption).toBe(false);
      expect(config).toEqual(defaultHubConfig());
      expect(existsSync(join(dir, "nested", "ai-hub-config.json"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("合法配置往返读写", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "ai-hub-config.json");
      const store = new HubConfigStore(file);
      const custom = { ...defaultHubConfig(), sites: [{ id: "mine", name: "M", url: "https://m.com", adapter: "generic" as const }] };
      store.saveSync(custom);
      const reread = new HubConfigStore(file).loadSync();
      expect(reread.config).toEqual(custom);
      expect(reread.resetFromCorruption).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("损坏文件备份为 .bak 并重置默认", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "ai-hub-config.json");
      writeFileSync(file, "{ not valid json !!!", "utf8");
      const store = new HubConfigStore(file);
      const { config, resetFromCorruption } = store.loadSync();
      expect(resetFromCorruption).toBe(true);
      expect(config).toEqual(defaultHubConfig());
      expect(existsSync(`${file}.bak`)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("deepseek");
    } finally {
      cleanup(dir);
    }
  });

  it("超范围站点字段被归一化（保存后再读不丢预设）", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "ai-hub-config.json");
      const store = new HubConfigStore(file);
      store.saveSync({ version: 1, sites: [{ id: "s1", name: "S", url: "https://s.com", adapter: "generic" }] });
      const { config } = store.loadSync();
      expect(config.sites[0].id).toBe("s1");
    } finally {
      cleanup(dir);
    }
  });
});

describe("newCustomSiteId", () => {
  it("生成 custom- 前缀且不重复", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCustomSiteId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith("custom-")).toBe(true);
  });
});
