import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve the stable installation, rather than a last-used project or launcher version. */
export function projectPickerDirectory(serverDirectory, env = process.env, home = homedir()) {
  const configured = env.AGENTROAM_DATA_DIR?.trim();
  if (configured) return resolve(configured);
  const installed = join(home, ".agentroam");
  try {
    if (statSync(installed).isDirectory()) return installed;
  } catch {
    // Source-only checkouts can run without the CLI installation.
  }
  return resolve(serverDirectory);
}
