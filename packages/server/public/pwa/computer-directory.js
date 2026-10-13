/** Browser-local connection directory. pages is only a legacy import; grants stay on their own origin. */
export const COMPUTER_STORAGE_KEY = "agentroam.computers.v1";
const MAX_COMPUTERS = 20;
const GRANT = /^[A-Za-z0-9_-]{43}$/;

/** @typedef {{ id: string, name: string, url: string, openMode: "current" | "new-tab" }} ComputerPage */
/** @typedef {{ origin: string, name: string, pages?: ComputerPage[], pagesMigrated?: boolean }} Computer */

export function normalizePageUrl(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 8192) throw new Error();
    const url = new URL(raw.trim().replace(/[，。]+$/, ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new Error("请填写有效的 http(s) 页面地址。"); }
}

/** @returns {ComputerPage[]} */
export function normalizeComputerPages(value) {
  if (!Array.isArray(value) || value.length > 20) return [];
  const pages = new Map();
  for (const entry of value) {
    if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || !["current", "new-tab"].includes(entry.openMode)) continue;
    try { pages.set(entry.id, { id: entry.id, name: entry.name.trim().slice(0, 60), url: normalizePageUrl(entry.url), openMode: entry.openMode }); } catch { /* Ignore invalid saved links. */ }
  }
  return [...pages.values()];
}

export function defaultPageOpenMode(raw) {
  try { const host = new URL(normalizePageUrl(raw)).hostname; return host === "qoder.com" || host.endsWith(".qoder.com") ? "new-tab" : "current"; } catch { return "current"; }
}

export function computerOrigin(raw) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

/** @returns {Computer[]} */
export function normalizeComputers(value) {
  if (!Array.isArray(value) || value.length > MAX_COMPUTERS) return [];
  const computers = new Map();
  for (const entry of value) {
    const origin = entry && typeof entry.origin === "string" ? computerOrigin(entry.origin) : null;
    if (!origin || typeof entry.name !== "string") continue;
    const name = entry.name.trim().slice(0, 60) || new URL(origin).hostname;
    const pages = normalizeComputerPages(entry.pages);
    computers.set(origin, { origin, name, ...(entry.pagesMigrated === true ? { pagesMigrated: true } : Array.isArray(entry.pages) ? { pages } : {}) });
  }
  return [...computers.values()];
}

/** @returns {Computer[]} */
export function readComputers(storage = localStorage) {
  try { return normalizeComputers(JSON.parse(storage.getItem(COMPUTER_STORAGE_KEY) || "[]")); }
  catch { return []; }
}

export function mergeComputers(...lists) {
  const byOrigin = new Map();
  for (const list of lists) for (const computer of normalizeComputers(list)) {
    const previous = byOrigin.get(computer.origin);
    const merged = { ...previous, ...computer };
    if (merged.pagesMigrated) delete merged.pages;
    byOrigin.set(computer.origin, merged);
  }
  if (byOrigin.size > MAX_COMPUTERS) throw new Error("最多可添加 20 台电脑。");
  return [...byOrigin.values()];
}

export function saveComputers(computers, storage = localStorage) {
  const normalized = normalizeComputers(computers);
  try { storage.setItem(COMPUTER_STORAGE_KEY, JSON.stringify(normalized)); }
  catch { throw new Error("浏览器无法保存电脑列表，请检查浏览器存储设置。"); }
  return normalized;
}

export function rememberComputer(origin, name, computers = readComputers()) {
  const normalized = computerOrigin(origin);
  if (!normalized) throw new Error("电脑地址无效。");
  const existing = computers.find(computer => computer.origin === normalized);
  return mergeComputers(computers, [{ origin: normalized, name: name?.trim() || existing?.name || new URL(normalized).hostname, ...(existing?.pages?.length ? { pages: existing.pages } : {}) }]);
}

export function readComputerHandoff(fragment) {
  if (fragment.length > 16_384) return { computers: [], name: "" };
  try {
    const value = JSON.parse(new URLSearchParams(fragment.slice(1)).get("computers") || "null");
    if (value?.version !== 1) return { computers: [], name: "" };
    return { computers: normalizeComputers(value.computers), name: typeof value.name === "string" ? value.name.trim().slice(0, 60) : "" };
  } catch { return { computers: [], name: "" }; }
}

/** Accept only the existing CLI URL or native QR format, never an arbitrary link. */
export function parsePairingTarget(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 2048) throw new Error();
    raw = raw.trim();
    if (raw.startsWith("{")) {
      const value = JSON.parse(raw), origin = computerOrigin(value.server);
      if (value.type !== "agentroam-pair" || value.version !== 1 || !origin || !GRANT.test(value.grant)) throw new Error();
      raw = origin + "/pair#pair=" + value.grant;
    }
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/pair" || url.search || !/^#pair=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error();
    return url;
  } catch { throw new Error("这不是 AgentRoam 授权二维码，请在电脑上重新生成。"); }
}

function attachDirectory(url, computers, name = "") {
  const params = new URLSearchParams(url.hash.slice(1));
  const connections = normalizeComputers(computers).map(computer => ({
    origin: computer.origin, name: computer.name,
    ...(computer.pagesMigrated ? { pagesMigrated: true } : {}),
    // Only the destination's not-yet-imported pages need a one-time handoff.
    ...(computer.origin === url.origin && !computer.pagesMigrated && computer.pages?.length ? { pages: computer.pages } : {}),
  }));
  params.set("computers", JSON.stringify({ version: 1, computers: connections, name: name.trim().slice(0, 60) }));
  if (params.toString().length > 16_383) throw new Error("电脑列表或待导入页面配置过长，请先导入旧页面后再切换电脑。");
  url.hash = params.toString();
  return url.href;
}

export function pairingNavigation(raw, computers, name = "") {
  return attachDirectory(parsePairingTarget(raw), computers, name);
}

/** /pair makes a same-origin auth check after a cross-site Strict-cookie navigation. */
export function computerNavigation(origin, computers) {
  const normalized = computerOrigin(origin);
  if (!normalized) throw new Error("电脑地址无效。");
  return attachDirectory(new URL(normalized + "/pair"), computers);
}
