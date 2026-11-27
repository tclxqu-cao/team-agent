import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { VoiceServiceClient } from "./voice-service-client.js";
export function findVoiceServiceEntry(appPath, resourcesPath) {
    return [
        join(appPath, "..", "voice-service", "dist", "main.js"),
        join(resourcesPath, "voice-service", "main.js"),
        join(resourcesPath, "app.asar.unpacked", "voice-service", "main.js"),
    ].find((candidate) => existsSync(candidate)) ?? null;
}
export function findVoiceServiceRuntime(options) {
    const isExecutable = (candidate) => {
        if (!candidate)
            return false;
        try {
            accessSync(candidate, constants.X_OK);
            return true;
        }
        catch {
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
export function getLocalVoiceServiceLaunch(options) {
    if (!options.serviceEntry)
        throw new Error("voice service entry is unavailable");
    if (!options.runtimeExecutable)
        throw new Error("voice service Node runtime is unavailable");
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
async function defaultProbe(url, token) {
    try {
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const response = await fetch(new URL("/health", url), {
            headers,
            signal: AbortSignal.timeout(1_500),
        });
        if (!response.ok)
            return false;
        const body = await response.json();
        return body.ready === true && body.asr === true;
    }
    catch {
        return false;
    }
}
export class VoiceServiceManager {
    constructor(options, dependencies) {
        this.options = options;
        this.managedProcess = null;
        this.client = null;
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
    async connect() {
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
        if (!this.options.serviceEntry || !this.options.runtimeExecutable)
            return { kind: "native" };
        if (!this.managedProcess) {
            this.managedProcess = this.dependencies.startLocal();
            const launched = this.managedProcess;
            console.warn("[voice] managed local service started", { pid: "pid" in launched ? launched.pid : undefined });
            const output = launched;
            output.stdout?.on("data", (chunk) => console.warn("[voice-service]", chunk.toString().trim()));
            output.stderr?.on("data", (chunk) => console.warn("[voice-service:error]", chunk.toString().trim()));
            launched.once("exit", (code, signal) => {
                console.warn("[voice] managed local service exited", { code, signal });
                if (this.managedProcess === launched)
                    this.managedProcess = null;
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
    close() {
        this.client?.close();
        this.client = null;
        if (this.managedProcess)
            console.warn("[voice] application closing managed local service");
        this.managedProcess?.kill();
        this.managedProcess = null;
    }
}
//# sourceMappingURL=voice-service-manager.js.map