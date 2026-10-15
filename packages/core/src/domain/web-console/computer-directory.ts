export interface SavedComputerConnection {
  origin: string;
  name: string;
}

export const MAX_SAVED_COMPUTERS = 20;

/** Connections contain display metadata only; pairing credentials stay on each device. */
export function validateComputerConnections(value: unknown): SavedComputerConnection[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED_COMPUTERS) throw new Error("最多可添加 20 台电脑。");
  const origins = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some(key => !["origin", "name"].includes(key))
      || typeof entry.origin !== "string" || entry.origin.length > 2048) throw new Error("电脑地址无效。");
    let url: URL;
    try { url = new URL(entry.origin); } catch { throw new Error("电脑地址无效。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || origins.has(url.origin)) throw new Error("电脑地址无效或重复。");
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.trim().length > 60) throw new Error("电脑名称需为 1–60 个字符。");
    origins.add(url.origin);
    return { origin: url.origin, name: entry.name.trim() };
  });
}
