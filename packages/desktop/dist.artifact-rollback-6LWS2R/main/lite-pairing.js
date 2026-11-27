import { readMobilePairingOrigin } from "./mobile-pairing.js";
/** Reuse a phone-ready CLI service; a local development server must not block first-run setup. */
export class LitePairingService {
    constructor(service, bootstrap, readOrigin = readMobilePairingOrigin, prepareSharing = async () => { }) {
        this.service = service;
        this.bootstrap = bootstrap;
        this.readOrigin = readOrigin;
        this.prepareSharing = prepareSharing;
        this.pending = null;
    }
    refresh() {
        if (!this.pending)
            this.pending = this.prepare().finally(() => { this.pending = null; });
        return this.pending;
    }
    async connect() {
        const status = await this.service.status();
        const choices = [...status.choices].sort((a, b) => Number(b.instanceId === status.selected?.instanceId) - Number(a.instanceId === status.selected?.instanceId));
        for (const choice of choices) {
            try {
                await this.readOrigin(choice.dataDir);
            }
            catch {
                continue;
            }
            if (choice.instanceId !== status.selected?.instanceId)
                await this.service.select(choice.instanceId);
            return true;
        }
        return false;
    }
    async prepare() {
        if (!await this.connect()) {
            const result = await this.bootstrap.prepare();
            if (result.phase !== "ready")
                throw new Error(result.message || "运行环境尚未就绪，请点击刷新重试。");
            if (!await this.connect())
                throw new Error("手机访问连接尚未就绪，请稍后点击刷新重试。");
        }
        // Authorization errors (including emergency lock) must remain visible, never switch services to bypass them.
        const invitation = await this.service.mobilePairing();
        await this.prepareSharing();
        return invitation;
    }
}
//# sourceMappingURL=lite-pairing.js.map