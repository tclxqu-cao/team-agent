import React from "react";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, Text } from "ink";
import { TuiApp } from "./App.js";
import { discoverDatabasePaths, readDesktopData } from "./desktop-data.js";
import { loadTuiModelSelection, resolveStartupModel } from "./model-config.js";
import { TuiRuntime } from "./runtime.js";
import { createCursorAwareOutput } from "./cursor-output.js";

function Fatal({ message }: { message: string }) {
  return <Text color="red">x {message}</Text>;
}

export async function startTui(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("agent-tui 需要交互式终端");
    process.exitCode = 1;
    return;
  }

  const workingDirectory = path.resolve(argv[0] || process.cwd());
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
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const desktopData = await readDesktopData(await discoverDatabasePaths(repoRoot));
  const persisted = await loadTuiModelSelection(configPath);
  const model = resolveStartupModel({
    persisted,
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
  const cursorOutput = createCursorAwareOutput(process.stdout);
  try {
    const snapshot = await runtime.initialize();
    const app = render(
      <TuiApp
        runtime={runtime}
        initialSnapshot={snapshot}
        profiles={desktopData.profiles}
        registeredProjects={desktopData.projects}
        configPath={configPath}
        env={env}
        warnings={desktopData.warnings}
        nativeCursor
      />,
      { exitOnCtrlC: false, stdout: cursorOutput.stdout },
    );
    try {
      await app.waitUntilExit();
    } finally {
      cursorOutput.restore();
    }
  } catch (error) {
    cursorOutput.restore();
    const instance = render(<Fatal message={error instanceof Error ? error.message : String(error)} />);
    await instance.waitUntilExit();
    process.exitCode = 1;
  }
}
