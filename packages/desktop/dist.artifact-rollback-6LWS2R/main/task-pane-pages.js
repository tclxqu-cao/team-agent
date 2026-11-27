export function taskPanePageId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? `task-pane-${value}` : null;
}
export function taskPanePageUrl(value) {
    if (typeof value !== "string")
        return null;
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    }
    catch {
        return null;
    }
}
export function taskPanePageRect(value) {
    if (!value || typeof value !== "object")
        return null;
    const rect = value;
    if (![rect.x, rect.y, rect.width, rect.height].every(item => typeof item === "number" && Number.isFinite(item)))
        return null;
    if (rect.width <= 0 || rect.height <= 0)
        return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
/** Native website panes never receive Node integration or access to the host renderer's IPC. */
export function registerTaskPanePageIpc(ipc, manager, getWindow) {
    const trusted = (event) => {
        const window = getWindow();
        return Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
    };
    ipc.handle("task-page:open", async (event, rawId, rawUrl) => {
        const id = taskPanePageId(rawId), url = taskPanePageUrl(rawUrl);
        if (!trusted(event) || !id || !url)
            return { ok: false };
        try {
            await manager.openEmbeddedPage(id, url, { allowMedia: false });
            return { ok: true };
        }
        catch {
            return { ok: false };
        }
    });
    ipc.handle("task-page:set-bounds", (event, rawId, rawRect) => {
        const id = taskPanePageId(rawId);
        if (!trusted(event) || !id)
            return { ok: false };
        const rect = rawRect === null ? null : taskPanePageRect(rawRect);
        if (rawRect !== null && !rect)
            return { ok: false };
        manager.setEmbeddedPageBounds(id, rect);
        return { ok: true };
    });
    ipc.handle("task-page:reload", (event, rawId) => {
        const id = taskPanePageId(rawId);
        if (!trusted(event) || !id)
            return { ok: false };
        manager.reloadEmbeddedPage(id);
        return { ok: true };
    });
    ipc.handle("task-page:close", (event, rawId) => {
        const id = taskPanePageId(rawId);
        if (!trusted(event) || !id)
            return { ok: false };
        manager.closeEmbeddedPage(id);
        return { ok: true };
    });
}
//# sourceMappingURL=task-pane-pages.js.map