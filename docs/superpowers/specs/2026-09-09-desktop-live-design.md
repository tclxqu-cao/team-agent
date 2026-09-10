# 桌面画面直播与远程控制（Desktop Live View）设计

- 日期：2026-09-09
- 状态：已确认（用户批准：桌面 App 承担采集与注入；完整鼠标 + 键盘控制；DDD 开发）
- 关联：浏览器直播链路（`packages/core/src/domain/browser-live`、`packages/server/lib/browser-live`、WebApp `BrowserLivePanel`），wiki `projects/customer-agent/synthesis/codex-computer-use-webapp-projection`

## 1. 背景与目标

浏览器直播已在认证 `/ws` 上闭环：ego-browser / Codex Browser 画面以 JPEG 帧投到 WebApp 面板，支持接管输入与归还。本设计把第二个画面源——**本机桌面屏幕**——接入同一条管线，并支持从面板（手机/PC 浏览器）远程控制这台 Mac 的鼠标与键盘。

非目标（YAGNI）：多显示器选择、剪贴板注入、音频转发、WebRTC、桌面 App 内观看面板、把控制权交给 Codex computer-use 的自动仲裁。

## 2. DDD 分析

### 2.1 有界上下文与统一语言

现有 `browser-live` 上下文的真实概念不是「浏览器」，而是**实况画面与控制权交接**：某个画面源（agent 驱动的浏览器、本机桌面）发布会话，观看者可申请接管、注入归一化输入、归还控制权。桌面接入后继续叫 "browser" 会腐蚀模型语言，因此做一次**限界内的统一语言修正**：

- core 领域模块 `domain/browser-live` → `domain/live-view`。
- 领域类型改用源中立命名：`LiveViewSource`（`"ego-browser" | "codex-browser" | "desktop"`）、`LiveViewSessionView`、`LiveViewRegistry`、`LiveViewOwnershipState`。
- 兼容策略：core 保留 `BrowserLive*` 旧名作为**弃用别名导出**，server / desktop / webapp 现有 import 不受影响，按包逐步跟进。
- 传输层反腐蚀：wire 消息名 `browser:publish/watch/...` 与二进制 opcode 4/5 **保持不变**（避免破坏已验收的 Web Shell 桥、面板与 producer client），在 ws-server 处理器处注明这是传输层遗留命名，禁止渗入领域语言。

### 2.2 分层与依赖方向

```
core（领域 + 传输无关应用服务，无 UI / 无 Electron 依赖）
├── domain/live-view/            实体、LiveViewRegistry、所有权状态机、输入白名单（纯领域）
└── infrastructure/live-view/    LiveViewProducerClient（ws 传输）、LiveViewProducer（应用服务：
                                 编排 screencast 端口 + 控制权 gate 端口）   ← 自 server/lib 迁入（转 TS）

server（中继与运行时适配）
├── lib/browser-live/*.mjs       保留并 re-export core 新实现（旧路径 shim，测试不动）
├── lib/browser-live/*-runtime   ego / codex 运行时适配器（不迁移，属 server 运行时知识）
└── ws-server.mjs                /ws 中继：`browser:*` 处理器映射到 LiveViewRegistry

desktop（新增画面源基础设施，进程内组合根在主进程）
├── main/desktop-screen-live.ts  应用服务组合根：开关、权限预检、发布、所有权转换、重连
├── main/desktop-screen-screencast.ts  ScreencastPort 实现：desktopCapturer 采屏循环
├── main/desktop-input-gateway.ts      InputPort 实现：spawn Swift helper、JSON-lines 协议
└── native/desktop-input.swift         CGEvent 键鼠注入 + AXIsProcessTrusted 探测

webapp / renderer（表现层）
└── BrowserLivePanel.tsx         仅文案与类型跟进；交互逻辑零改动
```

依赖方向不变：`server → core`、`desktop → core`；web shell 桥与 iframe postMessage 不动。

### 2.3 领域不变量（沿用并显式化）

- 会话按同用户可见；producer 与会话一一绑定（`ESESSIONOWNED`）。
- 单 controller 写锁；接管必须等 `availability === "ready"`（首帧后）。
- 输入仅当 `controllerId === peer.id && state === "user-controlled"` 时转发；pointer 坐标归一化 `0..1`，key/文本白名单化。
- producer 断线 → 会话广播关闭；controller 断线 → 自动请求归还。
- desktop 源没有 agent gate：`pauseAgent / resyncAgent` 端口实现为 no-op；`agent-controlled` 在桌面语境下表述为「无人远程操作」。将来接 Codex computer-use 时在同一端口位替换实现，状态机不变。

## 3. 桌面画面源设计

### 3.1 生命周期与开关

- 设置项 `desktopLive.enabled`，默认 **false**；桌面端设置区新增开关，IPC 同步到主进程。
- 开启 → 权限预检 → 启动采屏 → `publish(backend/source: "desktop", sessionId: "desktop:primary", title: "桌面屏幕", availability: "starting")`。
- 关闭 / App 退出 → `browser:close`；ws 断线 → 指数退避重连并重发 publish（复用 client 的 `waitForDisconnect` 语义）。

### 3.2 权限模型（TCC）

| 权限 | 探测 | 缺失时行为 |
|---|---|---|
| 屏幕录制 | `systemPreferences.getMediaAccessStatus("screen")` | `availability=unavailable`，capabilityError 指明「系统设置 → 隐私与安全性 → 屏幕录制」 |
| 辅助功能 | helper `check` 命令回传 `AXIsProcessTrusted` | 画面正常直播；接管请求直接报错并给出「系统设置 → 隐私与安全性 → 辅助功能」引导，不进入 `user-controlled` |

已知约束：App 未签名（electron-builder `identity: null`），重编译后 TCC 授权可能需要重授；dev 期授权对象是 Electron 开发二进制。写入用户文档。

### 3.3 采屏（ScreencastPort 实现）

- `desktopCapturer.getSources({ types: ["screen"], thumbnailSize })` 循环，主显示器；`thumbnailSize` 上限 1440×900（与浏览器 adapter 封顶一致，保证帧 ≤ 640KB 领域上限）。
- 目标 4 FPS 起步，沿用既有自适应：发送耗时 > 500ms 或下游背压 → 逐级降到 2 FPS；稳定后逐级恢复。
- JPEG 质量 ~65（`NativeImage.toJPEG(65)`）；viewport 取主显示器逻辑尺寸 + `scaleFactor`（归一化坐标的换算基准）。
- 升级位：若 thumbnail 循环 CPU/画质不达标，可替换为隐藏窗口 `getUserMedia`（ScreenCaptureKit）实现，端口接口不变。

### 3.4 键鼠注入（InputPort 实现 + Swift helper）

- helper 常驻子进程，stdin/stdout JSON-lines；主进程关闭开关即 kill。
- 命令：
  - `check` → `{ trusted: boolean }`
  - 鼠标 `{op: "move"|"down"|"up"|"drag"|"wheel", x, y, button, deltaX, deltaY}`：`x/y` 为换算后的全局逻辑坐标（归一化 × viewport），`CGEventPost` 到 `kCGHIDEventTap`；滚轮用 `kCGScrollEventUnitPixel`。
  - 键盘 `{op: "key", action: "down"|"up", code, key, modifiers}`：web `KeyboardEvent.code` → HID virtual keycode 映射表（字母/数字/功能键/方向键/修饰键等常用集合），modifiers 走 `CGEventSetFlags`。
  - 文本 `{op: "text", text}`：`CGEventKeyboardSetUnicodeString`，支持中文等任意 Unicode。
- 归还（return）= 停止注入并回到 `agent-controlled`；helper 保持存活到开关关闭。
- 安全：helper 仅由桌面主进程在开关开启时 spawn；不监听任何网络端口；输入命令只来自已通过 registry 写锁校验的转发。

### 3.5 被控可见性（安全边界）

- 远程控制期间（`state ∈ {handoff-requested, user-controlled, return-requested, resyncing}`）：桌面 App 内显示持久横幅「正在被远程控制」，Dock icon 加 badge；状态解除即清除。
- 不静默扩权：开关默认关；首次开启时展示将获得的两个系统权限说明。

## 4. 表现层改动（最小）

- `BrowserLivePanel.tsx`：source 为 desktop 时 backendLabel 显示「桌面屏幕」；控制按钮文案「开始控制 / 结束控制」；url 行显示「本机屏幕」。
- desktop renderer 设置区新增「桌面直播与远程控制」开关 + 权限状态提示。
- `global.d.ts` 类型别名跟进 live-view 新名（保留旧名兼容）。

## 5. 测试与验收

- core：LiveViewRegistry 接受 desktop 源、接管/输入/归还状态机、别名导出存在；既有测试重命名后全绿。
- desktop：desktop-screen-live 组合根单测（fake ScreencastPort / fake InputPort / fake client）：开关生命周期、权限缺失降级、重连、所有权转换、被控横幅状态事件；input gateway 的命令编码与 helper 协议解析。
- server：既有 browser-live 测试经 shim 全绿；ws-server 无协议改动。
- webapp/renderer：面板文案单测更新。
- 真机验收：开启开关 → 授权两个权限 → 手机 WebApp（390 宽）看到桌面帧 → 接管 → 点击 Dock、滚动页面、输入中英文 → 归还 → 桌面横幅消失；关闭开关后会话广播关闭。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| thumbnail 循环 CPU 偏高 | 4 FPS 起步 + 自适应降速；预留 getUserMedia 升级位 |
| 未签名 App TCC 授权随重编译失效 | 文档说明；后续版本考虑固定 ad-hoc 签名 |
| keycode 映射遗漏特殊键 | 常用集合优先；未识别 code 回退文本注入 |
| rename 波及已验收链路 | wire 协议零改动；`BrowserLive*` 别名保编译；全量聚焦测试回归 |
