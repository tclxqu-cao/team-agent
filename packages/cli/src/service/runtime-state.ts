import {
  readServiceState,
  removeIfExists,
  writePrivateJson,
  writePrivateText,
  type ServicePaths,
  type ServiceProvider,
  type ServiceRuntimeState,
} from "./service-files.js";

interface ReadyState {
  localUrl: string;
  publicUrl: string;
  accessUrl: string;
  provider: ServiceProvider;
}

export class ServiceRuntimeReporter {
  private readonly startedAt: string;

  constructor(
    private readonly paths: ServicePaths,
    private readonly version: string,
    private readonly pid = process.pid,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = this.now().toISOString();
  }

  async starting(): Promise<void> {
    await removeIfExists(this.paths.urlPath);
    await this.write({ status: "starting" });
  }

  async ready(ready: ReadyState): Promise<void> {
    await this.write({ status: "ready", ...ready });
    await writePrivateText(this.paths.urlPath, `${ready.accessUrl}\n`);
  }

  async stopped(): Promise<boolean> {
    const current = await readServiceState(this.paths);
    if (!current || current.pid !== this.pid) return false;
    await this.write({ status: "stopped" });
    await removeIfExists(this.paths.urlPath);
    return true;
  }

  private async write(details: Omit<Partial<ServiceRuntimeState>, "pid" | "version" | "startedAt" | "updatedAt"> & {
    status: ServiceRuntimeState["status"];
  }): Promise<void> {
    await writePrivateJson(this.paths.statePath, {
      pid: this.pid,
      version: this.version,
      startedAt: this.startedAt,
      updatedAt: this.now().toISOString(),
      ...details,
    } satisfies ServiceRuntimeState);
  }
}
