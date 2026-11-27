import { createRequire } from "node:module";
import { resolveVoiceServiceConfig } from "./config.js";
import { AzureAsrEngine } from "./azure-asr-engine.js";
import { KwsEngine } from "./kws-engine.js";
import { findKwsModelFiles } from "./model-files.js";
import { createVoiceServer } from "./server.js";
import { buildKwsConfig, createSherpaEngines } from "./sherpa-runtime.js";
async function startAzure(config) {
    if (!config.azure)
        throw new Error("Azure configuration is required");
    // Cloud recognition does not require local ASR models, Python, or MLX.
    let kws;
    try {
        const addon = createRequire(import.meta.url)("sherpa-onnx-node");
        kws = new KwsEngine(new addon.KeywordSpotter(buildKwsConfig(findKwsModelFiles(config.kwsModelDir))));
    }
    catch {
        process.stderr.write("voice-service: optional local keyword detector unavailable\n");
    }
    const service = await createVoiceServer({
        host: config.host, port: config.port, token: config.token, provider: "azure",
        asrEngine: new AzureAsrEngine(config.azure), kwsEngine: kws,
    });
    process.stdout.write(`${JSON.stringify({ type: "ready", url: service.httpUrl, provider: "azure", asr: true, kws: Boolean(kws) })}\n`);
    let closing = false;
    const close = async () => {
        if (closing)
            return;
        closing = true;
        await service.close();
        process.exit(0);
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
}
async function main() {
    const config = resolveVoiceServiceConfig(process.env, process.cwd());
    if (config.provider === "azure")
        return startAzure(config);
    const require = createRequire(import.meta.url);
    const addon = require("sherpa-onnx-node");
    const engines = await createSherpaEngines(addon, config.asrModelDir, config.kwsModelDir);
    const service = await createVoiceServer({
        host: config.host,
        port: config.port,
        token: config.token,
        asrEngine: engines.asr,
        kwsEngine: engines.kws ?? undefined,
    });
    process.stdout.write(`${JSON.stringify({
        type: "ready",
        provider: "local",
        url: service.httpUrl,
        asr: true,
        kws: engines.kws !== null,
        addonVersion: addon.version ?? "unknown",
        kwsError: engines.kwsError?.message ?? null,
    })}\n`);
    let closing = false;
    const close = async () => {
        if (closing)
            return;
        closing = true;
        await service.close();
        process.exit(0);
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
}
main().catch((error) => {
    process.stderr.write(`voice-service: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=main.js.map