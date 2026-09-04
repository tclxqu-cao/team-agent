import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStartArguments } from "./service-controller.js";
import { ensurePrivateFile, resolveServicePaths, type ServiceConfig } from "./service-files.js";

interface WindowsServiceHostDependencies {
  spawnProcess?: typeof spawn;
}

export async function runWindowsServiceHost(
  configPath: string,
  dependencies: WindowsServiceHostDependencies = {},
): Promise<number> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as ServiceConfig;
  const paths = resolveServicePaths(undefined, config.dataDir);
  await Promise.all([ensurePrivateFile(paths.stdoutPath), ensurePrivateFile(paths.stderrPath)]);
  const [stdoutHandle, stderrHandle] = await Promise.all([open(paths.stdoutPath, "a"), open(paths.stderrPath, "a")]);
  const [command, ...args] = buildStartArguments(config);
  let child: ChildProcess | null = null;
  const requestStop = () => child?.kill("SIGTERM");

  try {
    child = (dependencies.spawnProcess ?? spawn)(command, args, {
      cwd: config.roots[0],
      env: { ...process.env, AGENTROAM_SERVICE: "1" },
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      windowsHide: true,
    });
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    return await waitForExit(child);
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("AgentRoam Windows service host requires a config path");
    process.exitCode = 2;
  } else {
    runWindowsServiceHost(configPath)
      .then((code) => { process.exitCode = code; })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
