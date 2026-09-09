import { readFile, writeFile } from "node:fs/promises";

export interface DesktopLivePersistedState {
  enabled: boolean;
}

export function normalizeDesktopLiveState(raw: unknown): DesktopLivePersistedState {
  if (!raw || typeof raw !== "object") return { enabled: false };
  return { enabled: (raw as { enabled?: unknown }).enabled === true };
}

export async function readDesktopLiveState(path: string): Promise<DesktopLivePersistedState> {
  try {
    const content = await readFile(path, "utf8");
    return normalizeDesktopLiveState(JSON.parse(content));
  } catch {
    return { enabled: false };
  }
}

export async function writeDesktopLiveState(path: string, state: DesktopLivePersistedState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
