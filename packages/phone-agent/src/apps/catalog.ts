import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEntry } from "../drivers/types.js";

export interface AppCatalogEntry {
  name: string;
  android?: string;
  ios?: string;
}

const FALLBACK_CATALOG: AppCatalogEntry[] = [
  { name: "淘宝", android: "com.taobao.taobao", ios: "com.taobao.taobao4iphone" },
  { name: "京东", android: "com.jingdong.app.mall", ios: "com.360buy.jdmall3" },
  { name: "设置", android: "com.android.settings", ios: "com.apple.Preferences" },
];

/** 读 apps.json（常用 App 名 → 包名/bundle id 映射，用户可自行增删）。 */
export function loadAppCatalog(): AppCatalogEntry[] {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "../../apps.json"),
    join(process.cwd(), "apps.json"),
  ];
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { android?: string; ios?: string }>;
      return Object.entries(raw).map(([name, ids]) => ({ name, android: ids.android, ios: ids.ios }));
    } catch {
      // 试下一个路径
    }
  }
  return FALLBACK_CATALOG;
}

/** 按名称或 id 找 App：支持中文名、英文名、包名子串。 */
export function resolveApp(
  query: string,
  installed?: AppEntry[],
): { id: string; matchedName: string } | null {
  const catalog = loadAppCatalog();
  const q = query.trim().toLowerCase();
  for (const entry of catalog) {
    if (
      entry.name.toLowerCase() === q ||
      entry.android?.toLowerCase() === q ||
      entry.ios?.toLowerCase() === q
    ) {
      const id = entry.android ?? entry.ios!;
      return { id, matchedName: entry.name };
    }
  }
  for (const entry of catalog) {
    if (entry.name.toLowerCase().includes(q)) {
      const id = entry.android ?? entry.ios!;
      return { id, matchedName: entry.name };
    }
  }
  // 安卓上再对已装应用做子串匹配（用户装了目录里没有的 App）
  for (const app of installed ?? []) {
    if (app.id.toLowerCase().includes(q)) {
      return { id: app.id, matchedName: app.name || app.id };
    }
  }
  return null;
}
