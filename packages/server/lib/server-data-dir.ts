import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const DEFAULT_SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveServerBaseDir(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_SERVER_DIR): string {
  return resolve(env.AGENT_DATA_DIR?.trim() || fallback);
}

export function getServerBaseDir(): string { return resolveServerBaseDir(); }
