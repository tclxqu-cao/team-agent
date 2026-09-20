import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhoneAgentConfig } from "../config.js";
import { resolveApp } from "../apps/catalog.js";
import type { PhoneDriver } from "../drivers/types.js";
import { SnapshotStore } from "../perception/snapshot.js";
import { buildSnapshot, isSensitiveNode, nodeCenter } from "../perception/ui-tree.js";
import type { VisionAnnotator } from "../perception/vision.js";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface PhoneToolDeps {
  driver: PhoneDriver;
  config: PhoneAgentConfig;
  snapshots: SnapshotStore;
  vision: VisionAnnotator;
}

function ok(text: string): ToolResult {
  return { text };
}

function fail(text: string): ToolResult {
  return { text: `ERROR: ${text}`, isError: true };
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

async function savePng(config: PhoneAgentConfig, png: Uint8Array): Promise<string> {
  await mkdir(config.artifactsDir, { recursive: true });
  const path = join(config.artifactsDir, `screen-${Date.now()}.png`);
  await writeFile(path, png);
  return path;
}

/** 组装手机工具集（MCP server 与 CLI 共用）。 */
export function buildPhoneTools(deps: PhoneToolDeps): ToolDef[] {
  const { driver, config, snapshots, vision } = deps;

  const refreshTree = async () => {
    const [xml, app] = await Promise.all([
      driver.uiTreeXml(),
      driver.currentApp().catch(() => "unknown"),
    ]);
    const snapshot = buildSnapshot({
      driverKind: driver.kind,
      xml,
      app,
      maxLines: config.maxTreeLines,
    });
    snapshots.set(snapshot);
    return snapshot;
  };

  return [
    {
      name: "phone_status",
      description:
        "检查手机连接状态：驱动类型、设备信息、屏幕尺寸、当前前台 App。任何手机任务开始前先调用它。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const status = await driver.status();
        if (!status.ok) return fail(status.detail);
        const [screen, app] = await Promise.all([
          driver.screenSize().catch(() => null),
          driver.currentApp().catch(() => "unknown"),
        ]);
        return ok(
          `驱动=${driver.kind} ${status.detail}\n屏幕=${screen ? `${screen.width}x${screen.height}` : "未知"}\n当前App=${app}`,
        );
      },
    },
    {
      name: "phone_ui_tree",
      description:
        "获取当前屏幕的可交互元素文本树（带序号）。phone_tap 的 index 来自这里。看不清屏幕内容时先调它。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ok((await refreshTree()).rendered),
    },
    {
      name: "phone_screenshot",
      description:
        "截取手机屏幕，保存 PNG 并返回文件路径。配置了视觉模型时可用 analyze 让模型描述截图内容。",
      inputSchema: {
        type: "object",
        properties: {
          analyze: { type: "boolean", description: "是否用视觉模型描述截图（需配置 PHONE_VISION_*）" },
          question: { type: "string", description: "analyze 时想从截图里知道什么" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const png = await driver.screenshot();
        const path = await savePng(config, png);
        let note = "";
        if (args.analyze === true) {
          if (!vision.enabled) {
            note = "\n(未配置 PHONE_VISION_BASEURL/PHONE_VISION_APIKEY/PHONE_VISION_MODEL，跳过视觉描述)";
          } else {
            try {
              const desc = await vision.annotate(png, strArg(args, "question"));
              note = `\n视觉描述: ${desc || "(模型未返回内容)"}`;
            } catch (err) {
              note = `\n视觉描述失败: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }
        return ok(`截图已保存: ${path}${note}`);
      },
    },
    {
      name: "phone_tap",
      description:
        "点击屏幕元素。优先传 index（来自最近的 phone_ui_tree）；屏幕变化后 index 会失效，需重新 phone_ui_tree。涉及支付/密码的按钮必须先征得用户同意并传 user_approved=true。",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "phone_ui_tree 输出里的 [序号]" },
          x: { type: "number" },
          y: { type: "number" },
          user_approved: { type: "boolean", description: "用户已明确同意本次敏感操作" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        let x = numArg(args, "x");
        let y = numArg(args, "y");
        const index = numArg(args, "index");
        if (index !== undefined) {
          const node = snapshots.node(index);
          if (!node) {
            return fail(
              `序号 ${index} 不存在或快照已过期（超过 ${Math.round(config.snapshotTtlMs / 1000)}s）。请重新调用 phone_ui_tree。`,
            );
          }
          if (isSensitiveNode(node) && args.user_approved !== true) {
            return fail(
              `[${index}] "${node.text || node.desc}" 疑似支付/账号敏感操作。请先向用户口头确认，同意后带 user_approved=true 重试。`,
            );
          }
          const c = nodeCenter(node);
          x = c.x;
          y = c.y;
        }
        if (x === undefined || y === undefined) return fail("需要 index 或 x/y 坐标");
        await driver.tap(x, y);
        await new Promise((r) => setTimeout(r, 600));
        return ok(`已点击 (${Math.round(x)},${Math.round(y)})。页面可能已变化，继续操作前建议 phone_ui_tree 刷新。`);
      },
    },
    {
      name: "phone_swipe",
      description: "滑动屏幕：传方向 up/down/left/right，或精确坐标 x1,y1,x2,y2。",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
          durationMs: { type: "number", description: "滑动时长，默认 400" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const durationMs = numArg(args, "durationMs") ?? 400;
        let x1 = numArg(args, "x1");
        let y1 = numArg(args, "y1");
        let x2 = numArg(args, "x2");
        let y2 = numArg(args, "y2");
        if (x1 === undefined || y1 === undefined) {
          const dir = strArg(args, "direction");
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
          if (!v) return fail("需要 direction 或 x1,y1,x2,y2");
          [x1, y1, x2, y2] = v;
        }
        if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
          return fail("滑动坐标不完整");
        }
        await driver.swipe(x1, y1, x2, y2, durationMs);
        await new Promise((r) => setTimeout(r, 500));
        return ok("已滑动。继续操作前建议 phone_ui_tree 刷新。");
      },
    },
    {
      name: "phone_input_text",
      description:
        "向当前聚焦的输入框输入文本（需先点击输入框获得焦点）。iOS 支持中文；Android 仅 ASCII。",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "要输入的内容" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const text = strArg(args, "text");
        if (!text) return fail("text 不能为空");
        await driver.inputText(text);
        return ok(`已输入文本（${[...text].length} 字符）。如需搜索请再点搜索/回车键。`);
      },
    },
    {
      name: "phone_press_key",
      description: "按系统键：back（返回）/ home（桌面）/ enter（回车）/ recent（最近任务，仅 Android）。",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["back", "home", "enter", "recent"] },
        },
        required: ["key"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const key = strArg(args, "key") as "back" | "home" | "enter" | "recent";
        if (!["back", "home", "enter", "recent"].includes(key)) return fail("key 不合法");
        await driver.pressKey(key);
        await new Promise((r) => setTimeout(r, 400));
        return ok(`已按 ${key}。`);
      },
    },
    {
      name: "phone_launch_app",
      description: "启动 App。app 支持中文名（淘宝/京东/拼多多/设置…，见 apps.json）或包名/bundle id。",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "App 中文名或包名" } },
        required: ["app"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const query = strArg(args, "app");
        if (!query) return fail("app 不能为空");
        const installed = driver.kind === "adb" ? await driver.listApps().catch(() => []) : [];
        const resolved = resolveApp(query, installed);
        if (!resolved) return fail(`找不到 App "${query}"。可在 apps.json 里补充映射。`);
        await driver.launchApp(resolved.id);
        await new Promise((r) => setTimeout(r, 1500));
        return ok(`已启动 ${resolved.matchedName}（${resolved.id}）。`);
      },
    },
    {
      name: "phone_list_apps",
      description: "列出可用 App（Android: 已装第三方应用；iOS: apps.json 配置表）。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const apps = await driver.listApps();
        if (apps.length === 0) return ok("(列表为空)");
        return ok(apps.map((a) => (a.name ? `${a.name}\t${a.id}` : a.id)).join("\n"));
      },
    },
    {
      name: "phone_wait",
      description: "等待页面加载。默认 1500ms，最长 10000ms。",
      inputSchema: {
        type: "object",
        properties: { ms: { type: "number" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const ms = Math.min(10_000, Math.max(100, numArg(args, "ms") ?? 1500));
        await new Promise((r) => setTimeout(r, ms));
        return ok(`已等待 ${ms}ms。`);
      },
    },
    ...(config.allowShell
      ? [
          {
            name: "phone_shell",
            description: `在手机上执行 adb shell 命令（仅 Android，PHONE_ALLOW_SHELL=1 时开启）。用于设置、通知等系统能力，如 "cmd notification post"。`,
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            },
            execute: async (args: Record<string, unknown>) => {
              const command = strArg(args, "command");
              if (!command) return fail("command 不能为空");
              if (driver.kind !== "adb") return fail("phone_shell 仅支持 Android");
              const adb = deps.driver as typeof deps.driver & {
                shell: (c: string) => Promise<string>;
              };
              const out = await adb.shell(command);
              return ok(out.trim() || "(无输出)");
            },
          } satisfies ToolDef,
        ]
      : []),
  ];
}
