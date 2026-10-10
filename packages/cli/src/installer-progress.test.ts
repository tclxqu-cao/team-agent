import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function progressHelpers(): Promise<string> {
  const source = await readFile(new URL("../install/install-agentroam.sh", import.meta.url), "utf8");
  return `set -eu\nPROGRESS_PID=""\n${source.slice(source.indexOf("stop_progress()"), source.indexOf("fail()"))}\ntrap stop_progress EXIT\n`;
}

function runPipedScript(source: string) {
  const child = spawn("/bin/sh", [], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTROAM_NO_PROGRESS: "0" },
  });
  let stdout = "";
  let stderr = "";
  let heartbeatBeforeExit = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if ([...stderr.matchAll(/已等待 (\d+) 秒/g)].some((match) => Number(match[1]) >= 5) && child.exitCode === null) heartbeatBeforeExit = true;
  });
  child.stdin.end(source);
  return new Promise<{ stdout: string; stderr: string; code: number | null; heartbeatBeforeExit: boolean }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code, heartbeatBeforeExit }));
  });
}

describe.skipIf(process.platform === "win32")("standalone shell installer progress", () => {
  it("reports while a piped installer is waiting without consuming script input or stdout", async () => {
    const result = await runPipedScript(`${await progressHelpers()}
run_with_progress '下载组件' /bin/sh -c 'sleep 6; printf "component-output\\n"'
printf 'remaining-script-ran\\n'
`);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("component-output\nremaining-script-ran\n");
    expect(result.stderr).toContain("下载组件（已等待 0 秒）");
    expect(result.stderr).toMatch(/下载组件（已等待 [5-9] 秒）/);
    expect(result.heartbeatBeforeExit).toBe(true);
  }, 10_000);

  it("preserves a command failure and removes its heartbeat process", async () => {
    const result = await runPipedScript(`${await progressHelpers()}
start_progress '校验组件'
heartbeat_pid=$PROGRESS_PID
stop_progress
if kill -0 "$heartbeat_pid" 2>/dev/null; then exit 99; fi
if run_with_progress '启动服务' /bin/sh -c 'exit 37'; then exit 98; else result_code=$?; fi
[ -z "$PROGRESS_PID" ] || exit 97
exit "$result_code"
`);
    expect(result.code).toBe(37);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("校验组件");
    expect(result.stderr).toContain("启动服务");
  });
});
