import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UpdateChecker, compareAgentRoamVersions, parseAgentRoamVersion, type UpdatePlatform, type UpdateStatus } from "@agent/core";

const ACTIVE_UPDATE_PHASES = new Set<UpdateStatus["phase"]>(["downloading", "installing", "reconnecting"]);

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
  private readonly unavailableStatus: UpdateStatus;
  private launchStatus: UpdateStatus | null = null;

  constructor(private readonly options: ServerUpdateServiceOptions) {
    this.spawnImpl = options.spawn ?? spawn;
    this.unavailableStatus = {
      phase: "unavailable",
      currentVersion: options.currentVersion,
      message: "当前电脑服务暂不支持在线更新。请使用 AgentRoam CLI 安装的电脑服务。",
    };
    this.checker = options.platform
      ? options.checker ?? new UpdateChecker({ currentVersion: options.currentVersion, client: "cli", platform: options.platform })
      : null;
    this.checker?.schedule();
  }

  async status(): Promise<UpdateStatus> {
    if (this.launchStatus?.phase === "downloading") return this.launchStatus;
    const durable = await this.readDurableStatus();
    const checked = this.checker?.getStatus() ?? this.unavailableStatus;
    const update = this.launchStatus ?? durable;
    if (!update || ACTIVE_UPDATE_PHASES.has(update.phase)) return update ?? checked;
    if (checked.phase === "checking" || checked.message || checked.phase === "up-to-date") return checked;
    if (checked.targetVersion && update.targetVersion && compareAgentRoamVersions(checked.targetVersion, update.targetVersion) > 0) return checked;
    return update;
  }

  requestCheck(): UpdateStatus {
    if (!this.checker) return this.unavailableStatus;
    void this.checker.refresh({ force: true }).catch(() => undefined);
    return this.launchStatus?.phase === "downloading" ? this.launchStatus : this.checker.getStatus();
  }

  async installAvailable(): Promise<UpdateStatus> {
    if (!this.options.cliPath || !this.options.dataDir || !this.options.platform) {
      throw Object.assign(new Error("updates require a packaged AgentRoam service"), { status: 409 });
    }
    const status = this.checker?.getStatus();
    if (!status || status.phase !== "available" || !status.targetVersion) {
      throw Object.assign(new Error("no validated update is available"), { status: 409 });
    }
    const durable = await this.readDurableStatus();
    if (this.launchStatus?.phase === "downloading") return this.launchStatus;
    if (durable && ACTIVE_UPDATE_PHASES.has(durable.phase)) return durable;
    const launching: UpdateStatus = { ...status, phase: "downloading" };
    this.launchStatus = launching;
    const worker = this.spawnImpl(process.execPath, [this.options.cliPath, "update", status.targetVersion, "--data-dir", this.options.dataDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const fail = () => {
      this.launchStatus = { ...launching, phase: "failed", message: "无法启动 CLI 更新，请检查电脑网络后重试" };
    };
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (code === 0) this.launchStatus = null;
      else fail();
    });
    worker.unref();
    return launching;
  }

  private async readDurableStatus(): Promise<UpdateStatus | null> {
    if (!this.options.dataDir) return null;
    try {
      const state = JSON.parse(await readFile(resolve(this.options.dataDir, "updates", "state.json"), "utf8")) as Record<string, unknown>;
      if (state.schemaVersion !== 1 || typeof state.phase !== "string" || typeof state.targetVersion !== "string") return null;
      if (!["downloading", "installing", "reconnecting", "complete", "failed"].includes(state.phase)) return null;
      if (compareAgentRoamVersions(state.targetVersion, this.options.currentVersion) <= 0) return null;
      if (ACTIVE_UPDATE_PHASES.has(state.phase as UpdateStatus["phase"])
        && (typeof state.updatedAt !== "number" || Date.now() - state.updatedAt > 30 * 60_000)) {
        return { phase: "failed", currentVersion: this.options.currentVersion, targetVersion: state.targetVersion, message: "更新已中断，请重试" };
      }
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
  const version = process.env.AGENTROAM_CLI_VERSION?.trim() || process.env.AGENTROAM_VERSION?.trim();
  const dataDir = process.env.AGENTROAM_DATA_DIR?.trim();
  const cliPath = process.env.AGENTROAM_CLI_PATH?.trim();
  return singleton ??= new ServerUpdateService({
    currentVersion: version || "0.0.0",
    platform: cliPath && dataDir && version && parseAgentRoamVersion(version) ? platformKey() : null,
    dataDir,
    cliPath,
  });
}
