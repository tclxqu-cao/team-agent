import { writeFile } from "node:fs/promises";
import { relayOrigin } from "../dist/tunnel/self-hosted-provider.js";

const configured = process.env.AGENTROAM_DEFAULT_HTTPS_RELAY?.trim();
const defaults = configured ? { url: relayOrigin(configured).origin } : {};
await writeFile(new URL("../dist/self-hosted-relay.json", import.meta.url), JSON.stringify(defaults) + "\n");
