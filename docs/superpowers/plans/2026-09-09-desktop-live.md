# Desktop Live View（桌面画面直播 + 远程控制）Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有浏览器直播管线上新增 `desktop` 画面源：桌面 Electron App 采集主屏幕出 JPEG 帧并发布为直播会话，WebApp 面板可观看，并经 Swift CGEvent helper 实现完整鼠标 + 键盘（含中文文本）远程控制。

**Architecture:** DDD 分层——core 持有 `live-view` 领域（源中立的会话/所有权/输入模型）与传输无关的 producer 应用服务；server 保留 `/ws` 中继与运行时 shim；desktop 主进程组合根串联 desktopCapturer 采屏端口与 Swift 注入端口；wire 协议（`browser:*` 消息名 + opcode 4/5）零改动。

**Tech Stack:** TypeScript (ES2022, bun workspaces)、Electron 32（desktopCapturer/systemPreferences/IPC）、Vitest、Swift + CGEvent/AXIsProcessTrusted（swiftc 编译，无三方依赖）、ws。

## Global Constraints

- wire 协议消息名 `browser:publish/list/watch/takeover/input/return/producer-state/close/frame` 与二进制 opcode 4/5 一律不改。
- 帧上限 640KB（`MAX_FRAME_BYTES`）；JPEG 质量 65；采屏分辨率按主显示器逻辑尺寸、封顶 1440×900。
- FPS：目标 4 起步，2–5 自适应（沿用 `#adaptFps` 语义：发送 >500ms 或 `accepted === false` 降 1 级，连续 2×targetFps 帧正常升 1 级）。
- `desktopLive.enabled` 默认 false；所有新能力必须显式开启。
- desktop 源的 `pauseAgent/resyncAgent` 为 no-op；所有权状态机与 browser 源共用。
- 旧名 `BrowserLive*` 在 core 以弃用别名保留；`domain/browser-live/` 与 `lib/browser-live/browser-live-producer*.mjs` 保留为 re-export shim。
- 项目 Git：标准 Git，禁止 git-ai / AI notes（仓库 CLAUDE.md）。
- 测试命令：根目录 `bunx vitest run <paths>`；类型检查 `bunx tsc --noEmit`（core/server/desktop 各自 tsconfig）；core 构建 `bun run --cwd packages/core build`。

---

### Task 1: core 领域重命名为 live-view 并支持 desktop 源

**Files:**
- Create: `packages/core/src/domain/live-view/entities.ts`
- Create: `packages/core/src/domain/live-view/live-view-registry.ts`
- Create: `packages/core/src/domain/live-view/index.ts`
- Modify: `packages/core/src/domain/browser-live/index.ts`（改为 shim）
- Delete: `packages/core/src/domain/browser-live/entities.ts`、`packages/core/src/domain/browser-live/BrowserLiveRegistry.ts`
- Move+Modify: `packages/core/src/domain/browser-live/BrowserLiveRegistry.test.ts` → `packages/core/src/domain/live-view/live-view-registry.test.ts`
- Modify: `packages/core/src/index.ts`（追加 live-view 导出）

**Interfaces:**
- Produces: `LiveViewSource = "ego-browser" | "codex-browser" | "desktop"`；`LiveViewSessionView`（字段同旧 `BrowserLiveSessionView`，`backend` 字段名保留、类型改 `LiveViewSource`）；`LiveViewInput`（同旧 `BrowserInput`）；`LiveViewOwnershipState`；`LiveViewPeer`；`class LiveViewRegistry`（方法签名同旧 Registry）。
- Produces（别名，向后兼容）：`BrowserBackend = LiveViewSource`、`BrowserInput = LiveViewInput`、`BrowserLiveSessionView = LiveViewSessionView`、`BrowserOwnershipState = LiveViewOwnershipState`、`BrowserLivePeer = LiveViewPeer`、`BrowserLiveRegistry = LiveViewRegistry`、`PublishBrowserSession = PublishLiveSession`。
- 不变式：`publish` 校验 source ∈ 白名单（现含 `"desktop"`）；desktop 源默认 `title` 取 `"桌面屏幕"`，其余源默认 `"浏览器"`。

- [ ] **Step 1: 迁移并重命名领域文件**

把 `entities.ts` 内容复制到 `domain/live-view/entities.ts` 并做机械重命名（所有 `Browser*` 类型名 → `LiveView*` 对应名，`BrowserBackend` → `LiveViewSource` 且联合类型追加 `"desktop"`；`BrowserInput` → `LiveViewInput`；`BrowserLiveAvailability` → `LiveViewAvailability`；`BrowserOwnershipState` → `LiveViewOwnershipState`；`BrowserTransport`/`BrowserViewport` → `LiveViewTransport`/`LiveViewViewport`；`BrowserLiveEvent` → `LiveViewEvent`；`BrowserLivePeer` → `LiveViewPeer`；`BrowserLiveSessionView` → `LiveViewSessionView`）。字段名 `backend` 保留不改（wire 兼容）。

`live-view-registry.ts`：复制 `BrowserLiveRegistry.ts`，重命名为 `LiveViewRegistry`，`PublishBrowserSession` → `PublishLiveSession`，`BACKENDS` 改名 `SOURCES` 并加入 `"desktop"`，内部 `BrowserLiveSession` → `LiveSession`、`BrowserFrame` → `LiveFrame`。默认标题逻辑改为：

```ts
title: source === "desktop" ? "桌面屏幕" : "浏览器",
```

（`publish` 内原 `title: "浏览器"` 处；错误文案中的 "browser backend" 改为 "live source"，其余错误文案不动。）

- [ ] **Step 2: 建 live-view/index.ts 与 browser-live shim**

`packages/core/src/domain/live-view/index.ts` 最终内容：

```ts
export type {
  LiveViewSource,
  LiveViewAvailability,
  LiveViewOwnershipState,
  LiveViewViewport,
  LiveViewTransport,
  LiveViewSessionView,
  LiveViewInput,
  LiveViewEvent,
  LiveViewPeer,
} from "./entities.js";
export { LiveViewRegistry } from "./live-view-registry.js";
export type { PublishLiveSession } from "./live-view-registry.js";
```

`packages/core/src/domain/browser-live/index.ts` 整体替换为（旧路径永久 shim）：

```ts
/** @deprecated 使用 `../live-view/index.js` 的 LiveView* 命名；Browser* 仅为兼容别名。 */
export type { LiveViewSource as BrowserBackend } from "../live-view/entities.js";
export type { LiveViewTransport as BrowserTransport } from "../live-view/entities.js";
export type { LiveViewAvailability as BrowserLiveAvailability } from "../live-view/entities.js";
export type { LiveViewOwnershipState as BrowserOwnershipState } from "../live-view/entities.js";
export type { LiveViewViewport as BrowserViewport } from "../live-view/entities.js";
export type { LiveViewSessionView as BrowserLiveSessionView } from "../live-view/entities.js";
export type { LiveViewInput as BrowserInput } from "../live-view/entities.js";
export type { LiveViewEvent as BrowserLiveEvent } from "../live-view/entities.js";
export type { LiveViewPeer as BrowserLivePeer } from "../live-view/entities.js";
export { LiveViewRegistry as BrowserLiveRegistry } from "../live-view/live-view-registry.js";
export type { PublishLiveSession as PublishBrowserSession } from "../live-view/live-view-registry.js";
```

注意 `BrowserViewport` 曾含 `deviceScaleFactor` 字段——`LiveViewViewport` 保持同结构。

- [ ] **Step 3: 迁移测试并补 desktop 用例**

把 `BrowserLiveRegistry.test.ts` 移到 `live-view/live-view-registry.test.ts`：import 改为 `./live-view-registry.js` 与 `./entities.js`，类型/类名用新 `LiveView*` 名。追加用例（保持文件既有 fake peer 风格）：

```ts
it("accepts a desktop source and defaults its title", () => {
  const registry = new LiveViewRegistry();
  const producer = fakePeer("p1");
  registry.connect(producer);
  const view = registry.publish(producer, { sessionId: "desktop:primary", backend: "desktop" });
  expect(view.backend).toBe("desktop");
  expect(view.title).toBe("桌面屏幕");
});

it("rejects unknown sources", () => {
  const registry = new LiveViewRegistry();
  const producer = fakePeer("p1");
  registry.connect(producer);
  expect(() => registry.publish(producer, { sessionId: "x", backend: "tv" })).toThrow(/unsupported/);
});
```

（若原测试文件的 fake peer 工厂名不同，按原文件实际助手函数名改写以上两个用例。）删除旧目录下 `entities.ts`、`BrowserLiveRegistry.ts`、旧测试文件。

- [ ] **Step 4: core index.ts 追加导出**

`packages/core/src/index.ts` 在既有 `export * from './domain/browser-live/index.js';` 后追加：

```ts
export * from './domain/live-view/index.js';
```

（两组导出名不重叠：旧名均为 `Browser*/PublishBrowserSession` 别名。）

---

### Task 2: core 基础设施迁移 producer client + producer，server 留 shim

**Files:**
- Create: `packages/core/src/infrastructure/live-view/producer-client.ts`
- Create: `packages/core/src/infrastructure/live-view/producer.ts`
- Create: `packages/core/src/infrastructure/live-view/index.ts`
- Create: `packages/core/src/infrastructure/live-view/producer.test.ts`（自 `packages/server/lib/browser-live/browser-live-producer.test.ts` 移植）
- Create: `packages/core/src/infrastructure/live-view/producer-client.test.ts`（自 `packages/server/lib/browser-live/browser-live-producer-client.test.ts` 移植）
- Modify: `packages/core/src/index.ts`（追加 infrastructure/live-view 导出）
- Modify: `packages/server/lib/browser-live/browser-live-producer-client.mjs`（改 shim）
- Modify: `packages/server/lib/browser-live/browser-live-producer.mjs`（改 shim）
- Delete: `packages/server/lib/browser-live/browser-live-producer.test.ts`、`browser-live-producer-client.test.ts`（已移植到 core）
- Modify: `packages/server/ws-server.mjs:56`（`BrowserLiveRegistry` → `LiveViewRegistry`，一行）

**Interfaces:**
- Consumes: Task 1 的领域类型。
- Produces: `class LiveViewProducerClient`，constructor `({ endpoint, fetchImpl?, WebSocketImpl?, timeoutMs? })`；方法 `connect(): Promise<void>`、`onEvent(l: (e: {type:string}) => void): () => void`、`publish(metadata): Promise<{ channelId: number }>`、`frame(sessionId: string, frame: { sequence:number; data: Uint8Array|string; title?:string; url?:string; viewport?:unknown }): Promise<{accepted:boolean}>`、`state(sessionId, state: LiveViewOwnershipState)`、`unavailable(sessionId, error: unknown)`、`waitForDisconnect(): Promise<void>`、`close(sessionId): Promise<unknown>`、`disconnect(): void`。
- Produces: `class LiveViewProducer`，constructor `({ client, screencast, metadata, pauseAgent, resyncAgent, onError? })`；`run(): Promise<void>`。screencast 端口形状：`start(onFrame) / stop() / dispatchInput(input)`。
- Server shim 签名：`browser-live-producer-client.mjs` 导出 `BrowserLiveProducerClient`（= core `LiveViewProducerClient`）；`browser-live-producer.mjs` 导出 `BrowserLiveProducer`（= core `LiveViewProducer`）。ego/codex runtime 文件零改动。

- [ ] **Step 1: 移植 producer-client.ts**

复制 `browser-live-producer-client.mjs` 逻辑为 TS，类名 `LiveViewProducerClient`。socket 用最小结构类型（不引入 `ws` 类型依赖）：

```ts
interface LiveSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  on(event: "close" | "error" | "open", cb: () => void): void;
  once(event: "open" | "error", cb: (error?: Error) => void): void;
}
type WebSocketFactory = new (url: string, options: { headers: Record<string, string> }) => LiveSocket;
```

`defaultWebSocketImplementation` 保留 `createRequire(import.meta.url)("ws")` 惰性解析（core 不依赖 ws，由消费方解析）。`nodeFetch`/`defaultFetchImplementation`/`toWsUrl`/二进制 opcode 5 打包逻辑逐行保留。响应类型 `publish()` 返回 `{ channelId: number }`（读 `result.channelId`）。

- [ ] **Step 2: 移植 producer.ts**

复制 `browser-live-producer.mjs` 为 TS，类名 `LiveViewProducer`；screencast 参数类型为接口：

```ts
export interface LiveScreencastPort {
  start(onFrame: (frame: { data: Uint8Array | string; viewport: unknown; title: string; url: string; timestamp: number }) => Promise<{ accepted?: boolean } | void>): Promise<void>;
  stop(): Promise<void>;
  dispatchInput(input: LiveViewInput): Promise<void>;
}
```

事件处理逻辑（takeover → pauseAgent → user-controlled；input → 仅 user-controlled 时 `dispatchInput`；return → resync → agent-controlled）逐行保留。

- [ ] **Step 3: infrastructure/live-view/index.ts 与 core 导出**

```ts
export { LiveViewProducerClient } from "./producer-client.js";
export { LiveViewProducer } from "./producer.js";
export type { LiveScreencastPort } from "./producer.js";
```

`packages/core/src/index.ts` 追加 `export * from './infrastructure/live-view/index.js';`。

- [ ] **Step 4: 移植两个测试文件**

把 server 的 `browser-live-producer.test.ts` / `browser-live-producer-client.test.ts` 内容复制到 core 新测试文件：import 改 `./producer.js` / `./producer-client.js`，类名改 `LiveViewProducer` / `LiveViewProducerClient`，其余断言不改。删除 server 侧两个测试文件。

- [ ] **Step 5: server shim**

`browser-live-producer-client.mjs` 全文替换：

```js
/** @deprecated 实现已迁至 @agent/core infrastructure/live-view；此 shim 仅为旧 import 路径保留。 */
export { LiveViewProducerClient as BrowserLiveProducerClient } from "@agent/core";
```

`browser-live-producer.mjs` 同理导出 `BrowserLiveProducer`。

- [ ] **Step 6: ws-server 改用新名**

`ws-server.mjs:56` 改为 `const liveViewRegistry = new LiveViewRegistry();`，import 与文内全部 `browserLiveRegistry` 引用同步替换为 `liveViewRegistry`（纯重命名，处理器键名 `browser:*` 不动）。

---

### Task 3: desktop 采屏端口 + 注入网关 + 组合根（含单测）

**Files:**
- Create: `packages/desktop/main/desktop-input-gateway.ts`
- Create: `packages/desktop/main/desktop-screen-screencast.ts`
- Create: `packages/desktop/main/desktop-screen-live.ts`
- Unit tests: `packages/desktop/main/desktop-input-gateway.test.ts`、`desktop-screen-screencast.test.ts`、`desktop-screen-live.test.ts`

**Interfaces:**
- Consumes: core `LiveViewProducerClient`、`LiveViewProducer`、`LiveViewInput`、`LiveViewOwnershipState`、`LiveScreencastPort`。
- Produces:
  - `class DesktopInputGateway`：constructor `({ helperPath, spawnImpl?, lineTimeoutMs? })`；`start(): Promise<void>`、`stop(): Promise<void>`、`checkAccessibility(): Promise<boolean>`、`dispatch(input: DesktopInputCommand): Promise<void>`。
  - `type DesktopInputCommand`：`{op:"move"|"down"|"up", x:number, y:number, button:"left"|"right"|"middle"} | {op:"drag", x, y} | {op:"wheel", deltaX:number, deltaY:number} | {op:"key", action:"down"|"up", code:string, modifiers:string[]} | {op:"text", text:string}`。
  - `class DesktopScreenScreencast` 实现 `LiveScreencastPort`：constructor `({ input, displayInfo, captureSource, fps?, quality?, maxWidth?, maxHeight?, firstFrameTimeoutMs?, sleep? })`。
  - `class DesktopScreenLive`：constructor `({ endpoint?, client?, input, screencast, probeScreen?, probeAccessibility?, now? })`；`enable(): Promise<DesktopLiveStatus>`、`disable(): Promise<DesktopLiveStatus>`、`getStatus(): DesktopLiveStatus`、`onStatus(cb): () => void`。
  - `type DesktopLiveStatus = { enabled: boolean; permissionScreen: "granted"|"denied"|"not-determined"|"restricted"|"unknown"; accessibilityTrusted: boolean | null; sessionOnline: boolean; controlState: LiveViewOwnershipState | null; error?: string }`。

- [ ] **Step 1: DesktopInputGateway**

JSON-lines over stdio；请求带自增 `id`，`Map<id, {resolve,reject,timer}>` 路由响应；行解析按 `\n` 缓冲。进程退出时拒绝所有 pending 并置 `started=false`。命令编码（node → swift）：

```ts
private toCommand(input: LiveViewInput, viewport: { width: number; height: number }): DesktopInputCommand {
  if (input.kind === "pointer") {
    const x = Math.round(input.x * viewport.width);
    const y = Math.round(input.y * viewport.height);
    if (input.action === "wheel") return { op: "wheel", deltaX: Math.round(input.deltaX), deltaY: Math.round(input.deltaY) };
    if (input.action === "move") return { op: "drag" ... } // 见下
    ...
  }
}
```

规则（实现据此写全）：`down/up` 带归一化换算后的绝对坐标与 button；`move` 在指针按下期间（gateway 内部跟踪 `pointerDown` 状态，遇 `down` 置 true、`up` 置 false）发 `{op:"drag"}`，否则发 `{op:"move"}`；`wheel` 原样传像素增量；`input.text && !input.key && !input.code` → `{op:"text"}`；其余 key → `{op:"key", action, code, modifiers}`。gateway 自身不做坐标换算——换算放在 screencast（持有 viewport）；gateway 的 `dispatch` 只接收 `DesktopInputCommand`，测试直接断言编码后的命令行 JSON。

- [ ] **Step 2: DesktopScreenScreencast**

构造依赖全部注入以便单测：`displayInfo(): { width: number; height: number; scaleFactor: number }`（逻辑尺寸）、`captureSource(thumbnailSize): Promise<{ id: string; thumbnail: { toJPEG: (q: number) => Buffer } | null } | null>`、`sleep(ms): Promise<void>`。`start(onFrame)` 循环：

1. `thumbnailSize = { width: Math.min(maxWidth, display.width), height: Math.min(maxHeight, display.height) }`；
2. `captureSource(thumbnailSize)` 取主屏（匹配 `primary` 或第一条），无图重试下一轮；
3. `viewport = { width: Math.round(jpeg 尺寸/scaleFactor) … }`——用 `thumbnail` 实际像素除以 `scaleFactor`（desktopCapturer 等比缩放、无黑边，长宽比恒等于屏幕），首帧前用 `displayInfo` 逻辑尺寸；
4. `onFrame({ data: jpeg, viewport, title: "桌面屏幕", url: "", timestamp })`；
5. FPS 自适应：`accepted === false` 或本轮耗时 > 500ms → `targetFps = max(2, targetFps-1)`；连续 `2*targetFps` 帧正常且 `targetFps < maxFps` → `+1`（maxFps 默认 4，封顶 5）；
6. 首帧超时（默认 4000ms）未收到 captureSource 有效帧 → 抛 `code = "BROWSER_LIVE_STREAM_UNAVAILABLE"` 错误（沿用既有错误码，wire 语义不变）。

`stop()` 置 `running=false` 并幂等。`dispatchInput(input)`：换算归一化坐标 → 绝对逻辑坐标（`x*viewport.width`，viewport 以最近帧为准）→ 组装 `DesktopInputCommand` → `input.dispatch(cmd)`；`wheel` 不做坐标换算直接透传；文本规则同 gateway（`text && !key && !code` → `{op:"text"}`）。

- [ ] **Step 3: DesktopScreenLive 组合根**

```
enable():
  probeScreen() → 若非 granted：置 status(error="需要在 系统设置 → 隐私与安全性 → 屏幕录制 中授权…")，返回（不抛）
  probeAccessibility() → 记录 status.accessibilityTrusted（false 不阻断直播，仅记录）
  await input.start()；若 probeAccessibility 为 false，enable 仍继续，但 status.error 提示接管不可用
  producer = new LiveViewProducer({ client, screencast, metadata: { sessionId: "desktop:primary", backend: "desktop", title: "桌面屏幕", url: "", viewport: 初始 displayInfo 逻辑尺寸 }, pauseAgent: async () => {}, resyncAgent: async () => {} })
  runCompletion = producer.run()（后台，不 await）
  runCompletion.catch(e => 置 status.error 并广播)
  client 断线重连：run() 内 producer 已有 waitForDisconnect 语义（screencast.start 抛错时）→ 外层 while(enabled) 指数退避(1s,2s,4s…上限 30s) 重建 client.connect + producer.run
disable():
  enabled=false；await input.stop()；client.close("desktop:primary")（失败则 disconnect）
```

所有权状态变化经 `client.onEvent` 里 `browser:*state` 广播映射为 `status.controlState`（由 registry 广播的 session.state 提取，`session.id === "desktop:primary"` 时更新并 `emitStatus`）。`getStatus()` 返回快照对象。

- [ ] **Step 4: 三个单测**

跟随 `voice-service-manager.test.ts` 的注入风格（vitest，fake 注入，不碰真实 Electron API）：

- gateway：`spawnImpl` 返回 fake ChildProcess（`stdin` 收集 writes、`stdout` 可手动 `emitLine`）。断言：`dispatch({kind:"pointer",action:"down",…})` 写出 `{"id":1,"op":"down",…}`；`checkAccessibility()` 解析 `{"id":1,"ok":true,"trusted":false}` 返回 false；进程 `exit` 后 pending 全部拒绝且后续 dispatch 报错。
- screencast：fake `captureSource` 返回固定 buffer；断言首帧回调 data/viewport（缩放换算正确，如 display 2880×1800@2x、thumbnail 1440×900 → viewport 1440×900）；`onFrame` 返回 `{accepted:false}` 后 `sleep` 间隔变为 `1000/3`（4→3 FPS）；4000ms 无帧抛 `BROWSER_LIVE_STREAM_UNAVAILABLE`（用注入 timer/sleep 推进）。
- desktop-screen-live：fake client（记录 publish/frame/state 调用、可触发断线事件）+ fake screencast + probe 注入。断言：`probeScreen` denied 时 enable 不启动 producer 且 status.error 含「屏幕录制」；全 granted 时 enable 后 publish 参数 `backend:"desktop"`、`sessionId:"desktop:primary"`、`title:"桌面屏幕"`；`disable` 调用 `client.close`；状态事件更新 `controlState`。

---

### Task 4: Swift 注入 helper + 编译打包

**Files:**
- Create: `packages/desktop/native/desktop-input.swift`
- Create: `packages/desktop/scripts/build-desktop-input.sh`
- Modify: `packages/desktop/package.json`（scripts 增加 `build:helper`，挂进 `compile`/`build` 链）
- Modify: `packages/desktop/electron-builder.yml`（extraResources 增加 bin）
- Modify: `packages/desktop/.gitignore`（忽略 `assets/bin/`；若无此文件则建）

**Interfaces:**
- Consumes: Task 3 gateway 的命令编码。
- Produces: 二进制 `desktop-input`，stdin/stdout JSON-lines。请求：`{"id":N,"op":"check"}`、`{"id":N,"op":"move"|"down"|"up"|"drag","x":Int,"y":Int,"button":"left"|"right"|"middle"?}`、`{"id":N,"op":"wheel","deltaX":Int,"deltaY":Int}`、`{"id":N,"op":"key","action":"down"|"up","code":"KeyA"…,"modifiers":["Shift"…]?}`、`{"id":N,"op":"text","text":"你好"}`。响应：`{"id":N,"ok":true}`（check 附 `"trusted":Bool`）或 `{"id":N,"ok":false,"error":"…"}`。

- [ ] **Step 1: 编写 desktop-input.swift**

要点（完整实现写入文件）：

- `while let line = readLine(strippingNewline: true)`，`JSONSerialization` 解析；每条处理完 `print(response)` + `FileHandle.standardOutput.synchronizeFile()`/`fflush(stdout)`。
- 鼠标：`CGEvent(mouseEventSource: nil, mouseType:type, mouseClickState:down/up ? 1 : 0, mouseButton: button)`，`type` 映射：`move → .mouseMoved`、`drag → .leftMouseDragged`、`down → .leftMouseDown/.rightMouseDown/.otherMouseDown`、`up → 对应 Up`；坐标直接用全局逻辑点 `CGPoint(x:y:)`；`event.post(tap: .cghidEventTap)`。
- 滚轮：`CGEvent(scrollWheelEvent2Source: nil, wheelCount: 1, wheel1: Int32(clamping: -deltaY), wheel2: 0, wheel3: 0)`（wheel2 模式下传第二维：deltaX 非 0 时 wheelCount:2、wheel2 = -deltaX），随后 `event?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)` 以像素连续滚动；DOM 向下为正 → 取负。
- 键盘：`static let keycodes: [String: Int64]` 全表（ANSI）：字母 a–z（0x00,01,02,03,04,05,06,07,08,09,0B,0C,0D,0E,0F,10,11,12,13,14,15,16,17,18,19,1B→ 按 kVK 表：A=0,S=1,D=2,F=3,H=4,G=5,Z=6,X=7,C=8,V=9,B=0x0B,Q=0x0C,W=0x0D,E=0x0E,R=0x0F,Y=0x10,T=0x11,1=0x12,2=0x13,3=0x14,4=0x15,6=0x16,5=0x17,9=0x19,7=0x1A,8=0x1C,0=0x1D,O=0x1F,U=0x20,I=0x22,P=0x23,L=0x25,J=0x26,K=0x28,N=0x2D,M=0x2E，`Key{X}` 键名映射到对应值）；标点 `Minus=0x1B, Equal=0x18, BracketLeft=0x21, BracketRight=0x1E, Semicolon=0x29, Quote=0x27, Backslash=0x2A, Comma=0x2B, Period=0x2F, Slash=0x2C, Backquote=0x32`；控制键 `Space=0x31, Enter=0x24, Tab=0x30, Escape=0x35, Backspace=0x33, Delete=0x75, ArrowUp=0x7E, ArrowDown=0x7D, ArrowLeft=0x7B, ArrowRight=0x7C, Home=0x73, End=0x77, PageUp=0x74, PageDown=0x79, F1–F12=0x7A,0x78,0x63,0x76,0x60,0x61,0x62,0x64,0x65,0x6D,0x67,0x6F`。
- modifiers flags：`Shift → .maskShift, Control → .maskControl, Alt → .maskAlternate, Meta → .maskCommand`，`event.flags = flags`。
- 已知 keycode → `CGEvent(keyboardEventSource: nil, virtualKey: keycode, keyDown: down)` + flags + post；未知 code 但带 `key` 单字符 → 走 text 路径。
- text：down/up 两个 `CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: …)`，`event.keyboardSetUnicodeString(stringLength: text.utf16.count, unicodeString: [unichar])`，flags 保留（让 Shift+字母等组合可用）。
- `check` → `AXIsProcessTrusted()`（import ApplicationServices）。

- [ ] **Step 2: 编译脚本**

`scripts/build-desktop-input.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets/bin
swiftc -O -o assets/bin/desktop-input native/desktop-input.swift
file assets/bin/desktop-input
```

`package.json` scripts 增加 `"build:helper": "bash scripts/build-desktop-input.sh"`，并把 `bun run build:helper &&` 前置到既有 `compile` 脚本最前（保持原有命令不变地串联）。

- [ ] **Step 3: 打包与忽略**

`electron-builder.yml` extraResources 追加：

```yaml
  - from: assets/bin
    to: bin
```

`packages/desktop/.gitignore` 追加 `assets/bin/`。运行时解析顺序（Task 5 接线使用，gateway 的 `helperPath` 由调用方传入）：打包态 `join(process.resourcesPath, "bin", "desktop-input")`，开发态 `join(__dirname, "../../assets/bin/desktop-input")`（`app.isPackaged` 区分；`__dirname` 为 `dist/main`）。

---

### Task 5: 主进程接线 + IPC + 设置 UI + 被控横幅

**Files:**
- Modify: `packages/desktop/main/index.ts`（组合根实例化、IPC、持久化）
- Create: `packages/desktop/main/desktop-live-state.ts`（开关持久化，纯函数便于测试）
- Unit tests: `packages/desktop/main/desktop-live-state.test.ts`
- Modify: `packages/desktop/main/preload.ts`（暴露 `desktopLive` API）
- Modify: `packages/desktop/renderer/global.d.ts`（`window.desktopLive` 类型；live-view 类型路径切换）
- Modify: `packages/desktop/renderer/components/SettingsPanel.tsx`（新增「桌面直播与远程控制」区）
- Modify: `packages/desktop/renderer/App.tsx`（被控横幅）

**Interfaces:**
- Consumes: Task 3 `DesktopScreenLive`、Task 4 helperPath 解析。
- Produces（IPC 契约）：`desktop-live:get-status → DesktopLiveStatus`；`desktop-live:set-enabled (enabled: boolean) → DesktopLiveStatus`；主进程推送事件 `desktop-live:status`（payload = DesktopLiveStatus）。preload 暴露：

```ts
desktopLive: {
  getStatus: () => ipcRenderer.invoke("desktop-live:get-status"),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke("desktop-live:set-enabled", enabled),
  onStatus: (callback: (status: DesktopLiveStatus) => void) => { /* ipcRenderer.on("desktop-live:status", …); 返回取消函数 */ },
},
```

- [ ] **Step 1: desktop-live-state.ts**

`readDesktopLiveState(path): Promise<{ enabled: boolean }>` / `writeDesktopLiveState(path, state)`（JSON，缺文件按 `{enabled:false}`；解析失败按默认值并覆写）。单测覆盖：缺省、损坏 JSON、往返。

- [ ] **Step 2: 主进程实例化**

`index.ts` 在 app ready 后惰性创建（首次 `set-enabled(true)` 或 `get-status` 时）：`configPath = join(app.getPath("userData"), "desktop-live.json")`；helperPath 按 Task 4 Step 3 解析；`probeScreen = () => systemPreferences.getMediaAccessStatus("screen")`；`probeAccessibility = () => gateway.checkAccessibility()`（gateway 未启动时返回 null）。状态变化时 `mainWindow?.webContents.send("desktop-live:status", status)`。启动时读持久化 state，`enabled === true` 则自动 `enable()`（App 启动即恢复直播）。

- [ ] **Step 3: preload + 类型**

按 Interfaces 代码块补 preload（`contextBridge.exposeInMainWorld("desktopLive", …)`）；`global.d.ts` 增补 `DesktopLiveStatus` 类型（从 core live-view 实体 import 组合）与 `window.desktopLive`；同时把顶部 `import type { BrowserLiveSessionView } from "../../core/src/domain/browser-live/entities"` 改为 `import type { LiveViewSessionView } from "../../core/src/domain/live-view/entities"`、`export type BrowserLiveSession = LiveViewSessionView`（保旧名，面板零改动）。

- [ ] **Step 4: SettingsPanel 开关区**

在设置面板现有分区结构里新增一节（沿用既有控件样式类）：标题「桌面直播与远程控制」，说明文案「开启后，本机桌面画面将发布到直播面板，可从你的其他设备观看并控制鼠标键盘。」，开关绑定 `desktopLive.setEnabled`，下方展示两个权限状态行（屏幕录制 / 辅助功能：`granted|未授权`，未授权时附提示「去系统设置授权」按钮 → `window.open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")`（辅助功能为 `…Privacy_Accessibility`））。开关关闭时仅显示说明。

- [ ] **Step 5: App.tsx 被控横幅**

订阅 `window.desktopLive?.onStatus`；`status.enabled && status.controlState && status.controlState !== "agent-controlled"` 时在 App 顶层渲染固定顶栏（复用现有全局提示样式或新增 `.desktop-live-control-banner`）：「● 正在被远程控制」，`controlState === "resyncing"|"return-requested"` 时文案「正在结束远程控制」。状态解除即卸载。同时 Dock badge：主进程在状态变化处 `app.dock?.setBadge(controlled ? "●" : "")`。

---

### Task 6: 表现层面板文案（webapp/desktop 共享）

**Files:**
- Modify: `packages/desktop/renderer/components/BrowserLivePanel.tsx`
- Unit tests: `packages/desktop/renderer/components/BrowserLivePanel.test.ts`

**Interfaces:**
- Consumes: Task 1 `LiveViewSource` 含 `"desktop"`（wire 字段仍叫 `backend`）。
- Produces: desktop 源的展示文案。

- [ ] **Step 1: 文案与按钮**

`backendLabel`：`"desktop" → "桌面屏幕"`（其余不变）。`isDesktop = selected?.backend === "desktop"`；footer 按钮：接管按钮文案 `isDesktop ? "开始控制" : "接管浏览器"`，归还按钮 `isDesktop ? "结束控制" : "归还给 Agent"`；`browser-live-location` 的 url 行：`isDesktop` 时显示「本机屏幕」；状态标签 `STATE_LABELS` 对 desktop 保持共用（「无人操作」语义通过在 desktop 会话且 `state === "agent-controlled"` 时显示「未被远程控制」覆盖：`statusLabel` 计算处加该分支）。控制 cue 文案：`hasControl && isDesktop ? "当前输入会发送到本机" : 现文案`。

- [ ] **Step 2: 更新测试**

`BrowserLivePanel.test.ts` 追加用例：backend 为 `desktop` 的会话渲染 tab 文案「桌面屏幕」、按钮「开始控制」；点击后按钮变「结束控制」（沿用文件内既有渲染/交互测试手法）。既有文案断言不动。

---

### Task 7: 全量验证

见文末 Final Unit Test Verification；另需构建链验证（core build → desktop `tsc` → webapp build）与 wire 回归（server 既有 browser-live 相关测试全绿）。

---

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

```bash
cd /Users/caoqu/team-agent/customer-agent
bunx vitest run packages/core/src/domain/live-view packages/core/src/infrastructure/live-view packages/desktop/main/desktop-input-gateway.test.ts packages/desktop/main/desktop-screen-screencast.test.ts packages/desktop/main/desktop-screen-live.test.ts packages/desktop/main/desktop-live-state.test.ts packages/desktop/renderer/components/BrowserLivePanel.test.ts packages/server/lib/browser-live
```

Expected: PASS（0 failed）

- [ ] **类型检查与构建**

```bash
bun run --cwd packages/core build
bunx tsc --noEmit -p packages/core && bunx tsc --noEmit -p packages/server && bunx tsc --noEmit -p packages/desktop
bun run --cwd packages/webapp build
```

Expected: 全部通过。若测试失败，修复实现或测试后重跑直至通过，并在最终汇报中给出命令与结果。
