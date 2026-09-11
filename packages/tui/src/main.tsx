import React from "react";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, Text } from "ink";
import { TuiApp } from "./App.js";
import { discoverDatabasePaths, readDesktopData } from "./desktop-data.js";
import { loadInputHistory } from "./input-history.js";
import { loadTuiConfig, resolveStartupModel } from "./model-config.js";
import { TuiRuntime } from "./runtime.js";
import { createCursorAwareOutput } from "./cursor-output.js";
import { applyTheme } from "./theme.js";

function Fatal({ message }: { message: string }) {
  return <Text color="red">x {message}</Text>;
}

export async function startTui(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("agent-tui 需要交互式终端");
    process.exitCode = 1;
    return;
  }

  // --continue / -c reopen the newest session; --resume <prefix> reopens a match.
  const resumeFlagIndex = argv.indexOf("--resume");
  const wantsResume = resumeFlagIndex >= 0 || argv.includes("--continue") || argv.includes("-c");
  const resumePrefix = resumeFlagIndex >= 0 ? (argv[resumeFlagIndex + 1] ?? "") : "";
  const positional = argv.filter((arg, index) => !arg.startsWith("-") && index !== resumeFlagIndex + 1);
  const workingDirectory = path.resolve(positional[0] || process.cwd());
  try {
    if (!(await fsp.stat(workingDirectory)).isDirectory()) throw new Error("不是目录");
  } catch (error) {
    const instance = render(<Fatal message={`无法进入工作目录 ${workingDirectory}: ${error instanceof Error ? error.message : String(error)}`} />);
    await instance.waitUntilExit();
    process.exitCode = 1;
    return;
  }

  const storeDir = path.join(os.homedir(), ".customer-agent-tui");
  const configPath = path.join(storeDir, "config.json");
  const historyPath = path.join(storeDir, "input-history.json");
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const desktopData = await readDesktopData(await discoverDatabasePaths(repoRoot));
  const config = await loadTuiConfig(configPath);
  const inputHistory = await loadInputHistory(historyPath);
  const model = resolveStartupModel({
    persisted: config.active,
    endpoints: config.endpoints,
    profiles: desktopData.profiles,
    activeProfileId: desktopData.activeProfileId,
    env,
  });
  if (!model) {
    const instance = render(<Fatal message="没有可用模型。请在 Desktop 配置模型，或设置 AGENT_API_KEY。" />);
    await instance.waitUntilExit();
    process.exitCode = 1;
    return;
  }

  const runtime = new TuiRuntime(workingDirectory, model, storeDir);
  applyTheme(config.theme);
  // Config-derived runtime state must be in place before initialize() builds the agent.
  runtime.setMcpServers(config.mcpServers);
  runtime.setPermissionMode(config.permissionMode);
  const cursorOutput = createCursorAwareOutput(process.stdout);
  try {
    const snapshot = await runtime.initialize();
    let initialSessionId: string | undefined;
    if (wantsResume) {
      // initialize() already created a fresh session — never resume into it.
      const sessions = (await runtime.listSessions()).filter((session) => session.id !== snapshot.sessionId);
      const match = resumePrefix ? sessions.find((session) => session.id.startsWith(resumePrefix)) : sessions[0];
      if (match) initialSessionId = match.id;
      else console.error(`没有可恢复的会话${resumePrefix ? `（前缀 ${resumePrefix}）` : ""}，已新建会话`);
    }
    const app = render(
      <TuiApp
        runtime={runtime}
        initialSnapshot={snapshot}
        profiles={desktopData.profiles}
        registeredProjects={desktopData.projects}
        configPath={configPath}
        env={env}
        warnings={desktopData.warnings}
        initialConfig={config}
        initialHistory={inputHistory}
        historyPath={historyPath}
        initialSessionId={initialSessionId}
        nativeCursor
      />,
      { exitOnCtrlC: false, stdout: cursorOutput.stdout },
    );    try {
      await app.waitUntilExit();
    } finally {
      cursorOutput.restore();
      await runtime.shutdownMcp().catch(() => {});
    }
  } catch (error) {
    cursorOutput.restore();
    const instance = render(<Fatal message={error instanceof Error ? error.message : String(error)} />);
    await instance.waitUntilExit();
    process.exitCode = 1;
  } finally {
    runtime.closeHarness();
  }
}
