import { readFile, writeFile } from "node:fs/promises";
export function normalizeDesktopLiveState(raw) {
    if (!raw || typeof raw !== "object")
        return { enabled: false, displayId: null };
    const rawId = raw.displayId;
    return {
        enabled: raw.enabled === true,
        displayId: typeof rawId === "string" && rawId ? rawId : null,
    };
}
export async function readDesktopLiveState(path) {
    try {
        const content = await readFile(path, "utf8");
        return normalizeDesktopLiveState(JSON.parse(content));
    }
    catch {
        return { enabled: false, displayId: null };
    }
}
export async function writeDesktopLiveState(path, state) {
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
//# sourceMappingURL=desktop-live-state.js.map