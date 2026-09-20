#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createDriver } from "./drivers/index.js";
import { SnapshotStore } from "./perception/snapshot.js";
import { buildSnapshot, nodeCenter } from "./perception/ui-tree.js";
import { createVisionAnnotator } from "./perception/vision.js";
import { buildPhoneTools } from "./agent/phone-tools.js";
import { serveStdio } from "./mcp/server.js";
import { VoiceGateway, runOnce } from "./voice/gateway.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HELP = `phone-agent — 手机操作 agent（Android ADB / iOS WDA）

用法:
  phone-agent mcp                    启动 MCP stdio server（注册给 CA agent 用）
  phone-agent voice [--once "指令"]  启动语音唤醒网关；--once 直接执行一条指令
  phone-agent status                 查看手机连接状态
  phone-agent shot [输出.png]        截图
  phone-agent tree                   打印当前屏幕可交互元素树
  phone-agent tap <index|x y>        点击（序号来自 tree）
  phone-agent swipe <up|down|left|right>
  phone-agent text "hello"           输入文本（Android 仅 ASCII）
  phone-agent key <back|home|enter|recent>
  phone-agent open <App名|包名>      启动 App

环境变量见 README.md（PHONE_DRIVER、PHONE_ADB_SERIAL、PHONE_WDA_URL 等）。
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const config = loadConfig();

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }

  if (cmd === "mcp") {
    const { driver } = await createDriver(config);
    const tools = buildPhoneTools({
      driver,
      config,
      snapshots: new SnapshotStore(config.snapshotTtlMs),
      vision: createVisionAnnotator(config),
    });
    // artifacts 目录提前建好，agent 首次截图不因目录缺失失败
    await mkdir(config.artifactsDir || join(process.cwd(), ".phone-agent"), { recursive: true }).catch(() => undefined);
    await serveStdio(tools);
    return 0;
  }

  if (cmd === "voice") {
    const gateway = new VoiceGateway(config);
    const onceIdx = argv.indexOf("--once");
    if (onceIdx >= 0) {
      const text = argv[onceIdx + 1];
      if (!text) {
        console.error("--once 需要跟一条指令文本");
        return 2;
      }
      await runOnce(config, text);
      return 0;
    }
    await gateway.start();
    return 0;
  }

  const { driver, status } = await createDriver(config);
  const snapshots = new SnapshotStore(config.snapshotTtlMs);

  if (cmd === "status") {
    console.log(`驱动选择: ${config.driver}`);
    console.log(`${status.ok ? "OK" : "不可用"} — ${status.detail}`);
    return status.ok ? 0 : 1;
  }

  if (!status.ok) {
    console.error(`手机不可用: ${status.detail}`);
    return 1;
  }

  switch (cmd) {
    case "shot": {
      const png = await driver.screenshot();
      const out = argv[1] ?? join(process.cwd(), `screen-${Date.now()}.png`);
      await writeFile(out, png);
      console.log(`已保存 ${out} (${png.length} bytes)`);
      return 0;
    }
    case "tree": {
      const [xml, app] = await Promise.all([
        driver.uiTreeXml(),
        driver.currentApp().catch(() => "unknown"),
      ]);
      const snapshot = buildSnapshot({ driverKind: driver.kind, xml, app, maxLines: config.maxTreeLines });
      snapshots.set(snapshot);
      console.log(snapshot.rendered);
      return 0;
    }
    case "tap": {
      const a = argv[1];
      const b = argv[2];
      if (a === undefined) {
        console.error("用法: phone-agent tap <index> 或 tap <x> <y>");
        return 2;
      }
      if (b !== undefined && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) {
        await driver.tap(Number(a), Number(b));
        console.log(`已点击 (${a},${b})`);
        return 0;
      }
      const [xml, app] = await Promise.all([driver.uiTreeXml(), driver.currentApp().catch(() => "unknown")]);
      const snapshot = buildSnapshot({ driverKind: driver.kind, xml, app, maxLines: config.maxTreeLines });
      const node = snapshot.nodes.find((n) => n.index === Number(a));
      if (!node) {
        console.error(`序号 ${a} 不存在，先跑 phone-agent tree`);
        return 1;
      }
      const c = nodeCenter(node);
      await driver.tap(c.x, c.y);
      console.log(`已点击 [${a}] "${node.text || node.desc}" @ (${c.x},${c.y})`);
      return 0;
    }
    case "swipe": {
      const dir = argv[1] as "up" | "down" | "left" | "right";
      const screen = await driver.screenSize();
      const cx = screen.width / 2;
      const cy = screen.height / 2;
      const far = 0.35;
      const map: Record<string, [number, number, number, number]> = {
        up: [cx, cy + screen.height * far, cx, cy - screen.height * far],
        down: [cx, cy - screen.height * far, cx, cy + screen.height * far],
        left: [cx + screen.width * far, cy, cx - screen.width * far, cy],
        right: [cx - screen.width * far, cy, cx + screen.width * far, cy],
      };
      const v = map[dir];
      if (!v) {
        console.error("方向必须是 up/down/left/right");
        return 2;
      }
      await driver.swipe(v[0], v[1], v[2], v[3], 400);
      console.log(`已向 ${dir} 滑动`);
      return 0;
    }
    case "text": {
      await driver.inputText(argv.slice(1).join(" "));
      console.log("已输入");
      return 0;
    }
    case "key": {
      const key = argv[1] as "back" | "home" | "enter" | "recent";
      await driver.pressKey(key);
      console.log(`已按 ${key}`);
      return 0;
    }
    case "open": {
      const { resolveApp } = await import("./apps/catalog.js");
      const installed = driver.kind === "adb" ? await driver.listApps().catch(() => []) : [];
      const resolved = resolveApp(argv[1] ?? "", installed);
      if (!resolved) {
        console.error(`找不到 App "${argv[1]}"，可在 apps.json 补充`);
        return 1;
      }
      await driver.launchApp(resolved.id);
      console.log(`已启动 ${resolved.matchedName} (${resolved.id})`);
      return 0;
    }
    default:
      console.error(`未知命令: ${cmd}\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[phone-agent] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
