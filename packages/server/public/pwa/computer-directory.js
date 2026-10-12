/** Computer labels and addresses only. Authorization always stays on its own origin. */
export const COMPUTER_STORAGE_KEY = "agentroam.computers.v1";
const MAX_COMPUTERS = 20;
const GRANT = /^[A-Za-z0-9_-]{43}$/;

/** @typedef {{ origin: string, name: string }} Computer */

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
    computers.set(origin, { origin, name });
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
  for (const list of lists) for (const computer of normalizeComputers(list)) byOrigin.set(computer.origin, computer);
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
  return mergeComputers(computers, [{ origin: normalized, name: name?.trim() || existing?.name || new URL(normalized).hostname }]);
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
  params.set("computers", JSON.stringify({ version: 1, computers: normalizeComputers(computers), name: name.trim().slice(0, 60) }));
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
