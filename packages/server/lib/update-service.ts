import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UpdateChecker, compareAgentRoamVersions, type UpdatePlatform, type UpdateStatus } from "@agent/core";

export interface ServerUpdateServiceOptions {
  currentVersion: string;
  platform: UpdatePlatform | null;
  dataDir?: string;
  cliPath?: string;
  checker?: UpdateChecker;
  spawn?: typeof spawn;
}

export class ServerUpdateService {
  private readonly checker: UpdateChecker | null;
  private readonly spawnImpl: typeof spawn;
  private worker: ChildProcess | null = null;

  constructor(private readonly options: ServerUpdateServiceOptions) {
    this.spawnImpl = options.spawn ?? spawn;
    this.checker = options.platform
      ? options.checker ?? new UpdateChecker({ currentVersion: options.currentVersion, client: "cli", platform: options.platform })
      : null;
    this.checker?.schedule();
  }

  async status(): Promise<UpdateStatus> {
    const durable = await this.readDurableStatus();
    return durable ?? this.checker?.getStatus() ?? { phase: "unavailable", currentVersion: this.options.currentVersion };
  }

  requestCheck(): UpdateStatus {
    if (!this.checker) return { phase: "unavailable", currentVersion: this.options.currentVersion };
    void this.checker.refresh().catch(() => undefined);
    return this.checker.getStatus();
  }

  async installAvailable(): Promise<UpdateStatus> {
    if (!this.options.cliPath || !this.options.dataDir || !this.options.platform) {
      throw Object.assign(new Error("updates require a packaged AgentRoam service"), { status: 409 });
    }
    const status = this.checker?.getStatus();
    if (!status || status.phase !== "available" || !status.targetVersion) {
      throw Object.assign(new Error("no validated update is available"), { status: 409 });
    }
    if (this.worker && this.worker.exitCode === null) return this.status();
    this.worker = this.spawnImpl(process.execPath, [this.options.cliPath, "update", status.targetVersion, "--data-dir", this.options.dataDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    this.worker.unref();
    return { ...status, phase: "downloading" };
  }

  private async readDurableStatus(): Promise<UpdateStatus | null> {
    if (!this.options.dataDir) return null;
    try {
      const state = JSON.parse(await readFile(resolve(this.options.dataDir, "updates", "state.json"), "utf8")) as Record<string, unknown>;
      if (state.schemaVersion !== 1 || typeof state.phase !== "string" || typeof state.targetVersion !== "string") return null;
      if (!["downloading", "installing", "reconnecting", "complete", "failed"].includes(state.phase)) return null;
      if (state.phase === "complete" && compareAgentRoamVersions(state.targetVersion, this.options.currentVersion) <= 0) return null;
      return {
        phase: state.phase as UpdateStatus["phase"],
        currentVersion: this.options.currentVersion,
        targetVersion: state.targetVersion,
        message: typeof state.message === "string" ? state.message : undefined,
      };
    } catch { return null; }
  }
}

function platformKey(): UpdatePlatform | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-amd64";
  return null;
}

let singleton: ServerUpdateService | undefined;
export function getUpdateService(): ServerUpdateService {
  const version = process.env.AGENTROAM_VERSION?.trim();
  return singleton ??= new ServerUpdateService({
    currentVersion: version || "0.0.0",
    platform: version ? platformKey() : null,
    dataDir: process.env.AGENTROAM_DATA_DIR?.trim(),
    cliPath: process.env.AGENTROAM_CLI_PATH?.trim(),
  });
}
