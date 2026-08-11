import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VoiceServiceClient } from "./voice-service-client.js";

export type ManagedVoiceProcess = Pick<ChildProcess, "kill" | "once">;
export type VoiceProvider = { kind: "native" } | {
  kind: "service";
  source: "remote" | "local";
  client: VoiceServiceClient;
};

export function findVoiceServiceEntry(appPath: string, resourcesPath: string): string | null {
  return [
    join(appPath, "..", "voice-service", "dist", "main.js"),
    join(resourcesPath, "voice-service", "main.js"),
    join(resourcesPath, "app.asar.unpacked", "voice-service", "main.js"),
  ].find((candidate) => existsSync(candidate)) ?? null;
}

interface ManagerOptions {
  remoteUrl: string | null;
  remoteToken: string | null;
  localUrl: string;
  localToken: string | null;
  serviceEntry: string | null;
  cwd: string;
  env: Record<string, string | undefined>;
}

interface ManagerDependencies {
  probe: (url: string, token: string | null) => Promise<boolean>;
  startLocal: () => ManagedVoiceProcess;
}

async function defaultProbe(url: string, token: string | null): Promise<boolean> {
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(new URL("/health", url), {
      headers,
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ready?: boolean; asr?: boolean };
    return body.ready === true && body.asr === true;
  } catch {
    return false;
  }
}

export class VoiceServiceManager {
  private readonly dependencies: ManagerDependencies;
  private managedProcess: ManagedVoiceProcess | null = null;
  private client: VoiceServiceClient | null = null;

  constructor(
    private readonly options: ManagerOptions,
    dependencies?: ManagerDependencies,
  ) {
    this.dependencies = dependencies ?? {
      probe: defaultProbe,
      startLocal: () => {
        if (!options.serviceEntry) throw new Error("voice service entry is unavailable");
        const endpoint = new URL(options.localUrl);
        return spawn(process.execPath, [options.serviceEntry], {
          cwd: options.cwd,
          env: {
            ...process.env,
            ...options.env,
            ELECTRON_RUN_AS_NODE: "1",
            VOICE_SERVICE_HOST: endpoint.hostname,
            VOICE_SERVICE_PORT: endpoint.port || "17863",
            ...(options.localToken ? { VOICE_SERVICE_TOKEN: options.localToken } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
    };
  }

  async connect(): Promise<VoiceProvider> {
    this.client?.close();
    this.client = null;
    if (this.options.remoteUrl
      && await this.dependencies.probe(this.options.remoteUrl, this.options.remoteToken)) {
      this.client = new VoiceServiceClient({
        baseUrl: this.options.remoteUrl,
        token: this.options.remoteToken,
      });
      return { kind: "service", source: "remote", client: this.client };
    }
    if (await this.dependencies.probe(this.options.localUrl, this.options.localToken)) {
      this.client = new VoiceServiceClient({
        baseUrl: this.options.localUrl,
        token: this.options.localToken,
      });
      return { kind: "service", source: "local", client: this.client };
    }
    if (!this.options.serviceEntry) return { kind: "native" };

    if (!this.managedProcess) {
      this.managedProcess = this.dependencies.startLocal();
      const launched = this.managedProcess;
      launched.once("exit", () => {
        if (this.managedProcess === launched) this.managedProcess = null;
      });
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await this.dependencies.probe(this.options.localUrl, this.options.localToken)) {
        this.client = new VoiceServiceClient({
          baseUrl: this.options.localUrl,
          token: this.options.localToken,
        });
        return { kind: "service", source: "local", client: this.client };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.managedProcess?.kill();
    this.managedProcess = null;
    return { kind: "native" };
  }

  close(): void {
    this.client?.close();
    this.client = null;
    this.managedProcess?.kill();
    this.managedProcess = null;
  }
}
