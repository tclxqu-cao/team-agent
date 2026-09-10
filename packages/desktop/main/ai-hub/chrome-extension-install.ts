import { chmodSync, copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A per-user install directory keeps bootstrap credentials out of distributed code. */
export function prepareChromeExtension(source: string, destination: string, pairingCode: string): string {
  const match = /^aihub:(\d{1,5}):([a-f0-9]{64})$/.exec(pairingCode);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error("chrome-bridge-unavailable");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  for (const file of ["manifest.json", "background.js", "auto-connect.js", "bridge-client.js", "page-actions.js", "popup.html", "popup.js", "popup.css"]) {
    copyFileSync(join(source, file), join(destination, file));
  }
  const temporary = join(destination, "bootstrap.json.tmp");
  writeFileSync(temporary, JSON.stringify({ port: Number(match[1]), token: match[2] }), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, join(destination, "bootstrap.json"));
  return destination;
}
