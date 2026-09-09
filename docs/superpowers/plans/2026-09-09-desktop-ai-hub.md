# 桌面端 AI Hub（多 AI 网页聚合）实施计划

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AgentRoam 桌面端新增 "AI Hub" 功能：内嵌浏览器聚合多个网页版 AI（DeepSeek / ChatGPT / Gemini / Grok + 自定义站点），支持侧边站点栏切换、2-4 站分屏对比（分隔条可拖动）、一次输入同步发送到多站点、每站点独立持久会话分区。

**Architecture:** 渲染进程只画外壳（React），嵌入页面由主进程创建的 `WebContentsView` 承载；渲染进程用 `ResizeObserver` + rAF 测量各格子矩形，经 IPC `hub:set-bounds` 推给主进程 `setBounds`。同步发送：站点适配器（`executeJavaScript` 注入）优先，失败回退剪贴板粘贴模拟。规格来源：`docs/superpowers/specs/2026-09-09-ai-hub-electron-design.md`（原独立应用设计，本计划将其整合进现有桌面端）。

**Tech Stack:** Electron 32.3.3（`WebContentsView` 可用）+ React 18 + TypeScript + Vitest；主进程 ESM（Electron 经 `createRequire` 引入）；bun 工具链。

## Global Constraints

- 渲染器与 webapp 共享：一切依赖 `window.agentApi.hub*` 的 UI 必须做存在性门控，web shell 下不渲染入口、组件可空降级。
- 主进程新文件引 Electron 必须走 `createRequire` 模式（Electron 32 / Node 20.18 ESM 直引崩溃，见 `main/index.ts:1-5`）。
- preload 保持 CJS 兼容（`tsconfig.preload.json`，strict false），仍由 compile 脚本重命名为 `preload.cjs`。
- IPC 通道命名 `hub:action`，与现有 `namespace:action` 一致；preload 方法名 camelCase `hubXxx`。
- 样式遵循现状：inline style + `var(--token)`；顶部 52px 为拖拽区，视图矩形不得进入 y<52。
- `WebContentsView` 渲染在 DOM 之上：一切需要在网页上方显示的 UI（pane 头、错误层、BroadcastBar）必须位于视图矩形之外，由布局预留。
- 不做（本次范围外）：托盘、全局快捷键、nativeTheme 深色模式（与宿主应用现有"隐藏到后台"生命周期和皮肤系统冲突，原独立应用设计中的外围能力）；站点图标选择器（数据模型预留 `icon` 字段）；对话导出、多窗口。
- 站点配置存 `app.getPath("userData")/ai-hub-config.json`，原子写（tmp + rename），损坏备份 `.bak` 后重置。

## File Structure

```
packages/desktop/main/ai-hub/
  config.ts        # HubConfig/HubSite 类型、预设、normalize、原子读写、损坏恢复（纯函数 + IO 分离）
  config.test.ts
  adapters.ts      # 同步发送适配器脚本生成（纯函数，字符串注入）
  adapters.test.ts
  manager.ts       # AIHubManager：视图池、会话分区、UA 清洗、bounds、事件、broadcast 编排
packages/desktop/main/index.ts             # 实例化 + hub:* IPC + before-quit 清理
packages/desktop/main/preload.ts           # agentApi 增加 hubXxx + onHubEvent
packages/desktop/renderer/global.d.ts      # Hub* 类型 + AgentApi hub 方法
packages/desktop/renderer/lib/ai-hub-layout.ts      # 分屏矩形计算纯函数
packages/desktop/renderer/lib/ai-hub-layout.test.ts
packages/desktop/renderer/components/AIHubView.tsx  # Hub 主界面（站点栏/分屏/BroadcastBar）
packages/desktop/renderer/components/AIHubView.test.tsx
packages/desktop/renderer/components/ChatView.tsx   # 透传 onOpenHub
packages/desktop/renderer/components/ChatHeaderActions.tsx + test  # 入口按钮
packages/desktop/renderer/App.tsx                   # hubOpen 状态 + 内容区切换
```

---

### Task 1: 主进程配置模块（config.ts）

**Files:**
- Create: `packages/desktop/main/ai-hub/config.ts`
- Unit tests: `packages/desktop/main/ai-hub/config.test.ts`

**Interfaces:**
- Produces: `interface HubSite { id: string; name: string; url: string; icon?: string; adapter?: HubAdapterId }`、`interface HubConfig { version: 1; sites: HubSite[] }`、`type HubAdapterId = "deepseek" | "chatgpt" | "gemini" | "grok" | "generic"`、`PRESET_SITES: HubSite[]`、`normalizeHubConfig(raw: unknown): HubConfig`、`defaultHubConfig(): HubConfig`、`class HubConfigStore { constructor(filePath: string); loadSync(): { config: HubConfig; resetFromCorruption: boolean }; saveSync(config: HubConfig): void }`、`newCustomSiteId(): string`。

- [ ] **Step 1: 实现 config.ts**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type HubAdapterId = "deepseek" | "chatgpt" | "gemini" | "grok" | "generic";

export interface HubSite {
  id: string;
  name: string;
  url: string;
  icon?: string;
  adapter?: HubAdapterId;
}

export interface HubConfig {
  version: 1;
  sites: HubSite[];
}

export const PRESET_SITES: HubSite[] = [
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/", adapter: "deepseek" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", adapter: "chatgpt" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", adapter: "gemini" },
  { id: "grok", name: "Grok", url: "https://grok.com/", adapter: "grok" },
];

export function defaultHubConfig(): HubConfig { return { version: 1, sites: PRESET_SITES.map((s) => ({ ...s })) }; }

export function newCustomSiteId(): string { return `custom-${randomUUID().slice(0, 8)}`; }

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

// 容错归一化：坏条目丢弃、id 去重、字段截断，保证返回值永远可用
export function normalizeHubConfig(raw: unknown): HubConfig {
  const fallback = defaultHubConfig();
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as { sites?: unknown; version?: unknown };
  if (!Array.isArray(obj.sites)) return fallback;
  const sites: HubSite[] = [];
  const seen = new Set<string>();
  for (const item of obj.sites) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (!isHttpUrl(s.url)) continue;
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 40) : new URL(s.url).hostname;
    let id = typeof s.id === "string" && s.id.trim() ? s.id.trim().slice(0, 64) : newCustomSiteId();
    while (seen.has(id)) id = newCustomSiteId();
    seen.add(id);
    sites.push({
      id, name, url: s.url,
      ...(typeof s.icon === "string" && s.icon ? { icon: s.icon.slice(0, 200_000) } : {}),
      ...(s.adapter === "deepseek" || s.adapter === "chatgpt" || s.adapter === "gemini" || s.adapter === "grok" || s.adapter === "generic"
        ? { adapter: s.adapter } : {}),
    });
  }
  if (sites.length === 0) return fallback;
  return { version: 1, sites };
}

// 原子写 + 损坏恢复；IO 与纯函数分离以便测试（传入 filePath）
export class HubConfigStore {
  constructor(private readonly filePath: string) {}

  loadSync(): { config: HubConfig; resetFromCorruption: boolean } {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      const config = defaultHubConfig();
      this.saveSync(config);
      return { config, resetFromCorruption: false }; // 首次启动（文件不存在）不算损坏
    }
    const config = normalizeHubConfig(raw);
    const corrupted = config.sites.length === 0; // normalize 已兜底，不会为 0；保留语义占位
    this.saveSync(config);
    return { config, resetFromCorruption: corrupted };
  }

  saveSync(config: HubConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    try { renameSync(tmp, this.filePath); } catch { writeFileSync(this.filePath, JSON.stringify(config, null, 2), "utf8"); }
  }
}
```

注意：损坏→备份 `.bak` 的逻辑放在 manager 层做（需要先 rename 原文件再重建），`loadSync` 检测到 JSON.parse 失败且**文件确实存在**时：

```ts
// loadSync 内 parse 失败分支修正（文件存在但损坏）：
//   try { renameSync(this.filePath, `${this.filePath}.bak`); } catch {}
//   const config = defaultHubConfig(); this.saveSync(config);
//   return { config, resetFromCorruption: true };
```

用 `existsSync` 区分"文件不存在（首次启动，resetFromCorruption=false）"与"损坏（true）"。

- [ ] **Step 2: 测试 config.test.ts**（vitest，node env，用 `os.tmpdir()` 临时目录）
  覆盖：`normalizeHubConfig` 对预设原样通过、非法 URL/非对象丢弃、id 冲突去重、空 sites 回退默认；`HubConfigStore` 首次加载写默认文件、合法文件往返、损坏文件产生 `.bak` 且 `resetFromCorruption=true`。

### Task 2: 同步发送适配器（adapters.ts）

**Files:**
- Create: `packages/desktop/main/ai-hub/adapters.ts`
- Unit tests: `packages/desktop/main/ai-hub/adapters.test.ts`

**Interfaces:**
- Produces: `buildAdapterScript(adapter: HubAdapterId | undefined, text: string): string`（返回可交给 `webContents.executeJavaScript(script, true)` 的 IIFE 字符串，成功 resolve `true`，失败 reject）、`ENTER_DISPATCH_SCRIPT: string`（剪贴板回退路径用：向 `document.activeElement` 派发 Enter keydown/keyup）。

- [ ] **Step 1: 实现 adapters.ts**

适配器脚本（站点 DOM 会改版，选择器是尽力而为，剪贴板回退兜底）：

```ts
import type { HubAdapterId } from "./config";

// 每个适配器：输入框 selector 候选（依次尝试）+ 发送按钮 selector 候选（找不到则派发 Enter）
const ADAPTER_SELECTORS: Record<HubAdapterId, { inputs: string[]; sends: string[] }> = {
  deepseek: { inputs: ["#chat-input", "textarea"], sends: [] },
  chatgpt: { inputs: ["#prompt-textarea", "div[contenteditable='true']#prompt-textarea", "form div[contenteditable='true']"], sends: ["button[data-testid='send-button']", "button[aria-label='Send prompt']", "button[aria-label*='发送']"] },
  gemini: { inputs: ["rich-textarea div[contenteditable='true']", "div.ql-editor[contenteditable='true']", "div[contenteditable='true']"], sends: ["button[aria-label*='发送']", "button[aria-label*='Send']", "button.send-button"] },
  grok: { inputs: ["textarea[aria-label]", "textarea", "div[contenteditable='true']"], sends: ["button[type='submit']", "button[aria-label*='Submit']"] },
  generic: { inputs: [], sends: [] }, // generic 走"最大可见 textarea/contenteditable"启发式
};

export function buildAdapterScript(adapter: HubAdapterId | undefined, text: string): string {
  const spec = ADAPTER_SELECTORS[adapter ?? "generic"];
  const payload = JSON.stringify(text);
  const inputsJson = JSON.stringify(spec.inputs);
  const sendsJson = JSON.stringify(spec.sends);
  return `(async () => {
  const TEXT = ${payload};
  const INPUT_SELECTORS = ${adapter === "generic" || !spec.inputs.length ? "[]" : inputsJson};
  const SEND_SELECTORS = ${sendsJson};
  // —— 定位输入框：显式 selector 优先，否则取视口内最大的可见 textarea/contenteditable ——
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 12 && getComputedStyle(el).visibility !== "hidden"; };
  let input = null;
  for (const sel of INPUT_SELECTORS) { const el = document.querySelector(sel); if (el && visible(el)) { input = el; break; } }
  if (!input) {
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable='']")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect(); const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    input = best;
  }
  if (!input) throw new Error("input-not-found");
  input.focus();
  // —— 写入文本：textarea 用 native setter + input 事件（兼容 React 受控组件）；contenteditable 用 insertText ——
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, TEXT);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const sel = window.getSelection(); sel.removeAllRanges();
    const range = document.createRange(); range.selectNodeContents(input); sel.addRange(range);
    if (!document.execCommand("insertText", false, TEXT)) { input.textContent = TEXT; input.dispatchEvent(new InputEvent("input", { bubbles: true })); }
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  // —— 发送：优先点击按钮，否则派发 Enter ——
  for (const sel of SEND_SELECTORS) {
    const btn = [...document.querySelectorAll(sel)].find((b) => !b.disabled && b.getBoundingClientRect().width > 0);
    if (btn) { btn.click(); return true; }
  }
  const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent("keydown", opts));
  input.dispatchEvent(new KeyboardEvent("keyup", opts));
  return true;
})()`;
}

// 剪贴板回退：paste() 之后向当前焦点元素派发 Enter
export const ENTER_DISPATCH_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el) return false;
  const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
  return true;
})()`;
```

- [ ] **Step 2: 测试 adapters.test.ts**
  覆盖：每个 adapter 的脚本含对应 selector、文本以 JSON 转义安全嵌入（含引号/换行/`</script>`）、`new Function("(async()=>{})")` 语法可解析（用 `new Function(script.replace(...))` 或直接 `new Function(\`return ${script}\`)` 验证语法）、generic 与未定义 adapter 走启发式分支、`ENTER_DISPATCH_SCRIPT` 含 keydown/keyup。

### Task 3: AIHubManager（视图池 / 会话 / broadcast）

**Files:**
- Create: `packages/desktop/main/ai-hub/manager.ts`

**Interfaces:**
- Consumes: Task 1 `HubConfigStore`、Task 2 `buildAdapterScript` / `ENTER_DISPATCH_SCRIPT`。
- Produces: `interface HubPaneRect { siteId: string; x: number; y: number; width: number; height: number }`、`interface HubEvent { type: "loading" | "loaded" | "load-failed" | "title"; siteId: string; errorCode?: number; title?: string }`、`interface HubBroadcastResult { siteId: string; ok: boolean; reason?: string }`、`class AIHubManager { constructor(deps: { configPath: string; getWindow: () => BrowserWindow | null }); subscribe(fn: (e: HubEvent) => void): () => void; getConfig(): HubConfig; setConfig(raw: unknown): HubConfig; openSite(siteId: string): Promise<void>; closeSite(siteId: string): void; setBounds(panes: HubPaneRect[]): void; reloadSite(siteId: string): void; broadcast(text: string, siteIds: string[]): Promise<HubBroadcastResult[]>; destroyAll(): void }`。

- [ ] **Step 1: 实现 manager.ts**

关键行为：
- 视图池 `Map<siteId, WebContentsView>`；`openSite` 惰性创建：`partition: persist:aihub-<id>`、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`backgroundColor #ffffff`；UA 去 `Electron/x.y` 与 `AgentRoam/x.y` 特征串；`loadURL` 仅首次（池内已有则不重载，保留登录态）。
- 会话分区权限：`session.setPermissionRequestHandler` 仅放行 `"media"`（与主窗口一致）。
- 可见性：`contentView.addChildView(view)` 追加（位于应用 web contents 之上）；`setBounds` 只应用列表内格子（取整、丢弃 width/height<=0），**不在列表内的已开视图 hidden**（`removeChildView`，池保留）；`openSite` 创建后先 `removeChildView` 状态（等 bounds 推送再显示）→ 简化：`openSite` 不 addChildView，仅确保池存在并 `loadURL`；显示完全由 `setBounds` 驱动。
- 事件：`did-start-loading` / `did-finish-load` / `did-fail-load`(mainFrame && errorCode !== -3) / `page-title-updated` → subscribe 回调；`load-failed` 时主进程主动 `removeChildView`（让 DOM 错误层可见）。
- `broadcast`：逐站点，`executeJavaScript(buildAdapterScript(site.adapter, text), true)`；异常进入回退——保存剪贴板 → `clipboard.writeText(text)` → `webContents.focus()` + `paste()` → `executeJavaScript(ENTER_DISPATCH_SCRIPT)` → finally 恢复剪贴板；单站点失败不影响其他站点；回传 `HubBroadcastResult[]`。
- `setConfig`：normalize + 保存 + 池对账（被删除站点的视图 destroy）。
- `destroyAll`：`before-quit` 调，销毁全部视图。
- Electron 引入走 `createRequire`。

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebContentsView, clipboard } = require("electron") as typeof import("electron");
```

- [ ] **Step 2: index.ts 接线**

在 `DesktopUpdateService` 旁实例化（`mainWindow` 为 `let`，用 getter 闭包）：

```ts
const aiHubManager = new AIHubManager({
  configPath: join(app.getPath("userData"), "ai-hub-config.json"),
  getWindow: () => mainWindow,
});
aiHubManager.subscribe((event) => mainWindow?.webContents.send("hub:event", event));
```

IPC（放在 `// ── IPC: AI Hub ──` 分组，与现有风格一致）：

```ts
ipcMain.handle("hub:get-config", () => aiHubManager.getConfig());
ipcMain.handle("hub:set-config", (_e, raw: unknown) => aiHubManager.setConfig(raw));
ipcMain.handle("hub:open", (_e, siteId: string) => aiHubManager.openSite(siteId));
ipcMain.handle("hub:close", (_e, siteId: string) => aiHubManager.closeSite(siteId));
ipcMain.handle("hub:hide-all", () => aiHubManager.setBounds([]));
ipcMain.handle("hub:set-bounds", (_e, panes: HubPaneRect[]) => aiHubManager.setBounds(panes));
ipcMain.handle("hub:reload", (_e, siteId: string) => aiHubManager.reloadSite(siteId));
ipcMain.handle("hub:broadcast", (_e, text: string, siteIds: string[]) => aiHubManager.broadcast(text, siteIds));
```

`before-quit` 处理器中追加 `aiHubManager.destroyAll()`。

### Task 4: preload + global.d.ts

**Files:**
- Modify: `packages/desktop/main/preload.ts`（尾部追加）
- Modify: `packages/desktop/renderer/global.d.ts`

- [ ] **Step 1: preload 增加方法**（命名跟现有 camelCase 约定）

```ts
// AI Hub（内嵌多 AI 网页聚合）
hubGetConfig: () => ipcRenderer.invoke("hub:get-config"),
hubSetConfig: (raw: unknown) => ipcRenderer.invoke("hub:set-config", raw),
hubOpenSite: (siteId: string) => ipcRenderer.invoke("hub:open", siteId),
hubCloseSite: (siteId: string) => ipcRenderer.invoke("hub:close", siteId),
hubHideAll: () => ipcRenderer.invoke("hub:hide-all"),
hubSetBounds: (panes: Array<{ siteId: string; x: number; y: number; width: number; height: number }>) =>
  ipcRenderer.invoke("hub:set-bounds", panes),
hubReload: (siteId: string) => ipcRenderer.invoke("hub:reload", siteId),
hubBroadcast: (text: string, siteIds: string[]) => ipcRenderer.invoke("hub:broadcast", text, siteIds),
onHubEvent: (callback: (event: unknown) => void): (() => void) => {
  const handler = (_e: unknown, event: unknown) => callback(event);
  ipcRenderer.on("hub:event", handler);
  return () => ipcRenderer.removeListener("hub:event", handler);
},
```

- [ ] **Step 2: global.d.ts** 增加 `HubSite` / `HubConfig` / `HubPaneRect` / `HubEvent` / `HubBroadcastResult` 类型与 `AgentApi` 对应方法签名（与 preload 一一对应）。

### Task 5: 渲染层布局纯函数（ai-hub-layout.ts）

**Files:**
- Create: `packages/desktop/renderer/lib/ai-hub-layout.ts`
- Unit tests: `packages/desktop/renderer/lib/ai-hub-layout.test.ts`

**Interfaces:**
- Produces: `interface HubRect { x: number; y: number; width: number; height: number }`、`computePaneRects(container: HubRect, count: number, ratios: number[], opts?: { gap?: number }): HubRect[]`、`normalizeRatios(ratios: number[], count: number, min?: number): number[]`。

- [ ] **Step 1: 实现**：对比模式单行 n 列；`normalizeRatios` 把每段比例 clamp 到 `min=0.12` 后归一化为和 1 的 n-1 段（单列返回 `[]`）；`computePaneRects` 按 gap=8 分割容器宽、整像素取整、列间不重叠不越界（最后列吃齐右边界）。
- [ ] **Step 2: 测试**：1/2/3/4 列矩形正确、比例归一、极小比例 clamp、取整无缝隙无重叠、容器宽为 0 返回空。

### Task 6: AIHubView 组件

**Files:**
- Create: `packages/desktop/renderer/components/AIHubView.tsx`
- Unit tests: `packages/desktop/renderer/components/AIHubView.test.tsx`

**Interfaces:**
- Consumes: `window.agentApi.hub*`（global.d.ts）、Task 5 `computePaneRects` / `normalizeRatios`。
- Produces: `export default function AIHubView(props: { onExit: () => void }): JSX.Element | null`。

- [ ] **Step 1: 实现组件**，结构（全部 inline style + `var(--token)`，遵循代码库风格）：

```
根（absolute inset 0, zIndex 30, 背景 var(--bg-workspace), display flex column）
├── 顶栏 h52（WebkitAppRegion drag；左侧返回按钮 no-drag "← 返回对话"→onExit；标题 "AI Hub"；右侧 模式切换 单屏|对比）
├── 中部 flex row flex:1 minHeight:0
│   ├── 站点栏 w200（站点列表：单屏=radio 选中即切换；对比=checkbox 2-4 个；
│   │              每项：首字母头像 + 名称 + （自定义站点）删除按钮；
│   │              底部“添加站点”表单：name + url + 添加按钮）
│   └── 分屏容器 ref（flex row flex:1，内含 count 个 pane，分隔条 8px 可拖拽改 ratios）
│       └── 每个 pane（flex column）
│           ├── pane 头 h30（站点名 + 状态点 + 刷新按钮 + 关闭页面按钮）
│           └── 网页宿主 div ref data-site-id（flex:1，empty——WebContentsView 盖在这里）
│               （load-failed 或未 open 时显示错误层/占位层，此时视图已被主进程移除，DOM 可见）
└── BroadcastBar（h~86：textarea + 目标徽标（当前分屏站点数）+ 发送按钮 + 收起/展开；
                  发送中禁用；结果徽标 ok/fail 每站点一chip，8s 后自动清除）
```

行为要点：
- `const api = window.agentApi;` 不存在（web shell）→ 渲染居中提示"AI Hub 仅在桌面端可用" + 返回按钮，不注册任何效果。
- 挂载：`hubGetConfig()` 取站点；选中状态默认单屏第一个站点。
- 布局推送：`ResizeObserver` 观察每个网页宿主 div + `window resize`；回调 rAF 节流，收集 `getBoundingClientRect`（round 取整）→ `hubSetBounds(panes)`。宿主 div 数量/顺序变化（切换模式）后下一帧重推。
- 打开站点：进入分屏集合的站点 `hubOpenSite(siteId)`（幂等）；`hub:event` 中 `load-failed` 标记 failed 集合显示错误层（重试按钮 = `hubReload` + 重新 openSite）；`loaded` 清除 failed。
- 退出：`onExit` 由父组件触发卸载；`useEffect` cleanup 调 `hubHideAll()`（双保险）。
- 发送：`hubBroadcast(text, visibleSiteIds)` → 结果写入状态 chips。
- 添加站点：校验 http(s) URL → 组装 `{ id: "custom-…", name, url, adapter: "generic" }`（id 由主进程 setConfig 归一化也可，前端用 `crypto.randomUUID().slice(0,8)`）→ `hubSetConfig({ version: 1, sites: [...sites, newSite] })` → 用返回的规范配置更新状态。
- 删除站点：仅 `id.startsWith("custom-")` 可删；`hubCloseSite(id)` + `hubSetConfig`。

- [ ] **Step 2: 测试 AIHubView.test.tsx**（仿 `EmptySessionWelcome.test.tsx` 风格）
  - source-contract：`readFileSync` 源码断言——存在 `window.agentApi` 门控、`hubSetBounds` 推送、`ResizeObserver`、cleanup 调 `hubHideAll`、广播按钮、URL 校验。
  - `renderToStaticMarkup(<AIHubView onExit={() => {}} />)`：无 agentApi 时输出"仅在桌面端可用"提示且不抛异常。

### Task 7: 入口与内容区整合

**Files:**
- Modify: `packages/desktop/renderer/components/ChatHeaderActions.tsx`（新增可选 `onOpenHub` prop + 按钮，lucide `Columns3` 图标，title "AI Hub · 多模型对比"，置于浏览器直播按钮之前）
- Modify: `packages/desktop/renderer/components/ChatHeaderActions.test.ts`（补充 hub 按钮 contract 断言）
- Modify: `packages/desktop/renderer/components/ChatView.tsx`（`ChatViewProps` 增 `onOpenHub?: () => void`，解构并透传给 ChatHeaderActions，参与 `onOpenSettings && ...` 同款条件渲染）
- Modify: `packages/desktop/renderer/App.tsx`（`const [hubOpen, setHubOpen] = useState(false)`；内容区：`<div style={{ height: "100%", paddingTop: 0, display: hubOpen ? "none" : undefined }}><ChatView … onOpenHub={…} /></div>` 与 `<AIHubView onExit={() => setHubOpen(false)} />` 互斥渲染（ChatView 保持挂载仅隐藏）；`onOpenHub` 传 `window.agentApi?.hubGetConfig ? () => setHubOpen(true) : undefined`）

- [ ] **Step 1: ChatHeaderActions 按钮**（复用现有按钮 class 模式，条件渲染 `{onOpenHub && …}`）
- [ ] **Step 2: ChatView 透传**
- [ ] **Step 3: App.tsx 切换逻辑**
- [ ] **Step 4: 更新 ChatHeaderActions.test.ts**

### Task 8: 最终验证

- [ ] `bunx tsc --noEmit`（根目录，等价 lint）通过。
- [ ] `bunx vitest run packages/desktop/main/ai-hub packages/desktop/renderer/lib/ai-hub-layout.test.ts packages/desktop/renderer/components/AIHubView.test.tsx packages/desktop/renderer/components/ChatHeaderActions.test.ts` 全部 PASS。
- [ ] 手动验收清单（dev 模式，报告给用户自行确认）：四个预设站点可登录且重启保持；单屏切换/对比 2-4 站/分隔条拖动；同步发送多站成功、故意改坏适配器时剪贴板回退可用；自定义站点增删；Hub 与对话区往返切换无残留视图。

## Plan Validation

- 规格覆盖：§3 数据模型→Task 1；§4 视图与分屏→Task 3/5/6；§5 同步发送→Task 2/3/6；§7 IPC 面→Task 3/4；§8 错误处理→Task 3（load-failed 移除视图）/Task 6（错误层重试）；§9 测试→Task 1/2/5/6 + Task 8。原 §6 托盘/快捷键/深色模式按 Global Constraints 明确移出范围。
- 类型一致性：`HubSite`/`HubConfig`/`HubPaneRect` 在 config.ts 定义、global.d.ts 镜像（渲染进程不 import 主进程模块，沿用现有手写镜像约定）；preload 方法名与 AgentApi 一一对应。
