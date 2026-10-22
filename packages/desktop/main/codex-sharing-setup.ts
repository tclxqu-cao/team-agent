interface SharingResponse { state?: string; message?: string; confirmationRequired?: boolean; error?: { message?: string } }
interface SetupContext {
  request: (body: string) => Promise<{ status: number; body: string }>;
  confirm: () => Promise<boolean>;
  report: (message: string) => void;
}

export class DesktopCodexSharingSetup {
  private completed = false;
  private pending: Promise<void> | null = null;
  constructor(private readonly context: SetupContext) {}
  prepare(): Promise<void> {
    if (this.completed) return Promise.resolve();
    this.pending ??= this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async run(): Promise<void> {
    try {
      const send = async (action: string, restartConfirmed = false): Promise<SharingResponse> => {
        const response = await this.context.request(JSON.stringify({ action, restartConfirmed }));
        const value = JSON.parse(response.body) as SharingResponse;
        if (response.status !== 200) throw new Error(value.error?.message || "Codex 共享检查失败，请在头像菜单重试。");
        return value;
      };
      const status = await send("prepare");
      if (status.confirmationRequired !== true) {
        if (!["shared", "stopped", "not-installed", "unsupported"].includes(status.state ?? "")) {
          throw new Error(status.message || "CLI 尚未完成共享准备，请在头像菜单重试。");
        }
        this.completed = true;
        return;
      }
      if (!await this.context.confirm()) { this.completed = true; return; }
      const result = await send("share", true);
      if (result.state !== "shared") throw new Error(result.message || "尚未确认 Codex 已共享，请在头像菜单刷新。");
      this.completed = true;
    } catch (error) {
      this.context.report(error instanceof Error ? error.message : "Codex 共享检查失败，请在头像菜单重试。");
    }
  }
}
