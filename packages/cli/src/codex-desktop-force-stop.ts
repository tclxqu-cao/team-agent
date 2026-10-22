import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

interface ProcessIdentity { pid: number; parent: number; started: string; command: string }
interface StopContext {
  snapshot?: () => ProcessIdentity[];
  kill?: (pid: number) => void;
}

function snapshot(): ProcessIdentity[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,args="], { encoding: "utf8" }).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3]!, command: match[4]! }] : [];
  });
}

export function forceStopCodexDesktop(pid: number, binary: string, context: StopContext = {}): void {
  const read = context.snapshot ?? snapshot;
  const initial = read();
  const desktop = initial.find(row => row.pid === pid && (row.command === binary || row.command.startsWith(`${binary} `)));
  if (!desktop) throw new Error("Desktop process changed; no forced restart attempted.");
  const appRoot = binary.slice(0, binary.lastIndexOf("/Contents/MacOS/"));
  const backends = initial.filter(row => row.parent === pid && row.command.startsWith(`${appRoot}/Contents/`)
    && /\/codex\s.*\bapp-server(?:\s|$)/.test(row.command) && !/\bapp-server\s+(?:proxy|daemon)\b/.test(row.command));
  for (const target of [...backends, desktop]) {
    const current = read().find(row => row.pid === target.pid);
    if (!current) continue;
    if (current.started !== target.started || current.command !== target.command || current.parent !== target.parent) {
      throw new Error("Desktop process identity changed; forced restart stopped.");
    }
    try {
      (context.kill ?? (targetPid => process.kill(targetPid, "SIGKILL")))(target.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pid = Number(process.argv[2]);
    const binary = process.argv[3];
    if (!Number.isSafeInteger(pid) || pid <= 1 || !binary?.includes("/Contents/MacOS/")) throw new Error("Invalid Desktop process identity");
    forceStopCodexDesktop(pid, binary);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
