import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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

export function findVoiceServiceRuntime(options: {
  explicit: string | null;
  pathEnv: string | undefined;
  resourcesPath: string;
}): string | null {
  const isExecutable = (candidate: string | null): candidate is string => {
    if (!candidate) return false;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const fromPath = (options.pathEnv ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "node"));
  return [
    options.explicit,
    join(options.resourcesPath, "voice-service", "node"),
    ...fromPath,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].find(isExecutable) ?? null;
}

export function getVoiceServiceTtsEnvironment(options: {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): Record<string, string> {
  const developmentWorker = join(options.appPath, "..", "voice-service", "python", "mlx_tts_worker.py");
  const packagedRoot = join(options.resourcesPath, "voice-service");
  return {
    VOICE_TTS_PYTHON: options.env.VOICE_TTS_PYTHON?.trim() || (options.isPackaged
      ? join(packagedRoot, "tts-runtime", "bin", "python")
      : join(options.appPath, ".agent-data", "tts-runtime", "bin", "python")),
    VOICE_TTS_WORKER_SCRIPT: options.env.VOICE_TTS_WORKER_SCRIPT?.trim() || (options.isPackaged
      ? join(packagedRoot, "python", "mlx_tts_worker.py")
      : developmentWorker),
    VOICE_TTS_MODEL: options.env.VOICE_TTS_MODEL?.trim()
      || "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    VOICE_TTS_VOICE: options.env.VOICE_TTS_VOICE?.trim() || "Serena",
    VOICE_TTS_STREAMING_INTERVAL: options.env.VOICE_TTS_STREAMING_INTERVAL?.trim() || "0.32",
  };
}

export interface ManagerOptions {
  remoteUrl: string | null;
  remoteToken: string | null;
  localUrl: string;
  localToken: string | null;
  serviceEntry: string | null;
  runtimeExecutable: string | null;
  cwd: string;
  env: Record<string, string | undefined>;
  startupTimeoutMs?: number;
}

export function getLocalVoiceServiceLaunch(options: ManagerOptions): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  if (!options.serviceEntry) throw new Error("voice service entry is unavailable");
  if (!options.runtimeExecutable) throw new Error("voice service Node runtime is unavailable");
  const endpoint = new URL(options.localUrl);
  return {
    command: options.runtimeExecutable,
    args: [options.serviceEntry],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      VOICE_SERVICE_HOST: endpoint.hostname,
      VOICE_SERVICE_PORT: endpoint.port || "17863",
      ...(options.localToken ? { VOICE_SERVICE_TOKEN: options.localToken } : {}),
    },
  };
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
        const launch = getLocalVoiceServiceLaunch(options);
        return spawn(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
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
    if (!this.options.serviceEntry || !this.options.runtimeExecutable) return { kind: "native" };

    if (!this.managedProcess) {
      this.managedProcess = this.dependencies.startLocal();
      const launched = this.managedProcess;
      console.warn("[voice] managed local service started", { pid: "pid" in launched ? launched.pid : undefined });
      const output = launched as ManagedVoiceProcess & {
        stdout?: NodeJS.ReadableStream | null;
        stderr?: NodeJS.ReadableStream | null;
      };
      output.stdout?.on("data", (chunk) => console.warn("[voice-service]", chunk.toString().trim()));
      output.stderr?.on("data", (chunk) => console.warn("[voice-service:error]", chunk.toString().trim()));
      launched.once("exit", (code, signal) => {
        console.warn("[voice] managed local service exited", { code, signal });
        if (this.managedProcess === launched) this.managedProcess = null;
      });
    }
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (await this.dependencies.probe(this.options.localUrl, this.options.localToken)) {
        this.client = new VoiceServiceClient({
          baseUrl: this.options.localUrl,
          token: this.options.localToken,
        });
        return { kind: "service", source: "local", client: this.client };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn("[voice] managed local service readiness timed out; terminating it");
    this.managedProcess?.kill();
    this.managedProcess = null;
    return { kind: "native" };
  }

  close(): void {
    this.client?.close();
    this.client = null;
    if (this.managedProcess) console.warn("[voice] application closing managed local service");
    this.managedProcess?.kill();
    this.managedProcess = null;
  }
}
