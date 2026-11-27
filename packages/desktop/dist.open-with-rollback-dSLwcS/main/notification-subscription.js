import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
/** The main process owns subscription and cursor persistence; closing a chat
 * or suspending the renderer does not stop delivery. OS display is not read. */
export class DesktopNotificationSubscription {
    constructor(service, cursorFile, notify, warn) {
        this.service = service;
        this.cursorFile = cursorFile;
        this.notify = notify;
        this.warn = warn;
        this.stopped = true;
        this.connecting = false;
        this.epoch = 0;
        this.queue = Promise.resolve();
        this.readQueue = Promise.resolve();
        this.retryingReads = false;
    }
    start() { if (!this.stopped)
        return; this.stopped = false; this.timer = setInterval(() => { void this.connect(); this.retryReads(); }, 3000); void this.connect(); this.retryReads(); }
    stop() { this.stopped = true; this.epoch++; clearInterval(this.timer); this.service.stop("persistent-notifications"); }
    async readReceipts() {
        try {
            const value = JSON.parse(await readFile(`${this.cursorFile}.reads.json`, "utf8"));
            if (!Array.isArray(value) || value.some(item => !item || typeof item.serviceId !== "string" || typeof item.ownerId !== "string" || typeof item.notificationId !== "string"))
                throw new Error("Invalid notification read receipts");
            return value;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
    }
    async writeReceipts(receipts) {
        await mkdir(dirname(this.cursorFile), { recursive: true });
        const path = `${this.cursorFile}.reads.json`;
        await writeFile(`${path}.tmp`, JSON.stringify(receipts), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
    }
    markRead(receipt) {
        const persisted = this.readQueue.then(async () => {
            const receipts = await this.readReceipts();
            if (!receipts.some(item => item.serviceId === receipt.serviceId && item.ownerId === receipt.ownerId && item.notificationId === receipt.notificationId)) {
                await this.writeReceipts([...receipts, receipt]);
            }
        });
        this.readQueue = persisted.catch(this.warn);
        return persisted.then(() => { this.retryReads(); });
    }
    retryReads() {
        if (this.stopped || this.retryingReads)
            return;
        this.retryingReads = true;
        this.readQueue = this.readQueue.then(async () => {
            const receipts = await this.readReceipts();
            if (!receipts.length || this.stopped)
                return;
            const epoch = this.epoch;
            const identity = await this.service.json("/api/notifications", "GET");
            if (identity.status !== 200)
                throw new Error("Notification read identity check failed");
            const scope = JSON.parse(identity.body);
            for (const receipt of receipts.slice()) {
                if (epoch !== this.epoch || this.stopped)
                    return;
                if (receipt.serviceId !== scope.serviceId || receipt.ownerId !== scope.ownerId)
                    continue;
                await this.service.readNotification(receipt.notificationId, { serviceId: receipt.serviceId, ownerId: receipt.ownerId });
                receipts.splice(receipts.indexOf(receipt), 1);
                await this.writeReceipts(receipts);
            }
        }).catch(this.warn).finally(() => { this.retryingReads = false; });
    }
    async connect() {
        if (this.stopped || this.connecting)
            return;
        this.connecting = true;
        const epoch = this.epoch;
        try {
            const status = await this.service.status();
            if (!status.connected || epoch !== this.epoch)
                return;
            const identity = await this.service.json("/api/notifications", "GET");
            if (identity.status !== 200)
                return;
            const scope = JSON.parse(identity.body);
            if (!scope.serviceId || !scope.ownerId)
                return;
            const scopeKey = `${scope.serviceId}:${scope.ownerId}`;
            const saved = await readFile(this.cursorFile, "utf8").then(JSON.parse).catch(() => ({}));
            let buffer = "";
            await this.service.stream("persistent-notifications", "/api/notifications/stream", String(saved[scopeKey] ?? 0), (frame) => {
                if (epoch !== this.epoch || this.stopped || frame.type !== "data")
                    return;
                buffer += frame.data ?? "";
                let boundary;
                while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
                    if (!data)
                        continue;
                    this.queue = this.queue.then(async () => {
                        if (epoch !== this.epoch || this.stopped)
                            return;
                        const batch = JSON.parse(data);
                        if (`${batch.serviceId}:${batch.ownerId}` !== scopeKey)
                            throw new Error("Notification scope changed");
                        // Recheck through this same selected service before each OS display;
                        // a resolved approval must not be replayed from an offline batch.
                        const current = await this.service.json("/api/notifications", "GET");
                        if (current.status !== 200)
                            throw new Error("Notification recheck failed");
                        const latest = JSON.parse(current.body);
                        if (`${latest.serviceId}:${latest.ownerId}` !== scopeKey || epoch !== this.epoch)
                            return;
                        for (const n of batch.items) {
                            if (epoch !== this.epoch || this.stopped)
                                return;
                            await this.readQueue;
                            const pendingReads = await this.readReceipts();
                            const locallyRead = pendingReads.some(receipt => receipt.serviceId === batch.serviceId && receipt.ownerId === batch.ownerId && receipt.notificationId === n.id);
                            if (epoch !== this.epoch || this.stopped)
                                return;
                            const fresh = await this.service.json(`/api/notifications/${encodeURIComponent(n.id)}`, "GET");
                            if (epoch !== this.epoch || this.stopped)
                                return;
                            if (fresh.status !== 200)
                                throw new Error("Notification is no longer available");
                            const live = JSON.parse(fresh.body);
                            const displayed = !locallyRead && !live.dismissedAt && !live.readAt ? await this.notify(live, batch.preferences, batch.serviceId, () => this.markRead({ serviceId: batch.serviceId, ownerId: batch.ownerId, notificationId: live.id })) : false;
                            if (epoch !== this.epoch || this.stopped)
                                return;
                            const ack = await this.service.json(`/api/notifications/${encodeURIComponent(n.id)}/ack`, "POST", JSON.stringify({ displayed }));
                            if (ack.status !== 200)
                                throw new Error("Notification ACK failed");
                        }
                        saved[scopeKey] = batch.cursor;
                        await mkdir(dirname(this.cursorFile), { recursive: true });
                        await writeFile(this.cursorFile, JSON.stringify(saved), { mode: 0o600 });
                    }).catch(error => { this.warn(error); this.service.stop("persistent-notifications"); });
                }
            });
        }
        catch (error) {
            if (!this.stopped)
                this.warn(error);
        }
        finally {
            this.connecting = false;
        }
    }
    reconnect() { this.epoch++; this.service.stop("persistent-notifications"); }
}
//# sourceMappingURL=notification-subscription.js.map