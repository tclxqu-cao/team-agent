import { writeFile } from "node:fs/promises";
import { relayOrigin } from "../dist/tunnel/self-hosted-provider.js";

const releaseDefault = process.argv.includes("--release") ? "https://connect.kaiwuyouwei.com" : undefined;
const configured = process.env.AGENTROAM_DEFAULT_HTTPS_RELAY?.trim() || releaseDefault;
const defaults = configured ? { url: relayOrigin(configured).origin } : {};
await writeFile(new URL("../dist/self-hosted-relay.json", import.meta.url), JSON.stringify(defaults) + "\n");
