# @agent/phone-agent — 手机操作 Agent

让 CA agent（Customer Agent）直接操作你的手机：**语音唤醒 → 截屏/无障碍树感知 → 点按滑动 → 干活**（跨 App 购物比价、查东西、开应用等），干完用语音回答。

整体分四层，全部跑在 Mac 上、通过驱动控制手机，**手机上不需要装任何新东西**：

```
┌─ 语音层（可选独立进程）────────────────────────────────────────┐
│ phone-agent voice                                             │
│ ffmpeg 采麦克风 → voice-service「小智」唤醒 + 中文 ASR          │
│   → POST /api/agent/run → SSE → done.finalText                 │
│   → voice-service TTS → afplay 播放                            │
└──────────────────────┬────────────────────────────────────────┘
                       │ 会话（sessionId=phone-butler）
┌──────────────────────▼────────────────────────────────────────┐
│ CA agent 运行时（packages/server / desktop，复用不改）          │
│ ReAct 循环 + MCP client + skills + 会话/记忆                   │
└──────────────────────┬────────────────────────────────────────┘
                       │ MCP stdio（tools/call）
┌──────────────────────▼────────────────────────────────────────┐
│ phone-agent MCP server（本包）                                  │
│ phone_status / phone_ui_tree / phone_screenshot / phone_tap    │
│ phone_swipe / phone_input_text / phone_press_key /             │
│ phone_launch_app / phone_list_apps / phone_wait / phone_shell  │
│ 感知：无障碍树紧凑文本（主）+ 可选视觉模型描述（辅）             │
└──────────────────────┬────────────────────────────────────────┘
                       │ PhoneDriver
        ┌──────────────┴───────────────┐
        ▼ Android（adb）               ▼ iOS（WebDriverAgent）
  screencap / uiautomator dump    /session 截图 + /source
  input tap|swipe|text|keyevent   W3C actions 点按滑动
  monkey 启动 App / pm list       wda/apps/launch
  真机、模拟器均可                 真机需开发者签名跑 WDA
```

## 快速开始

### 1. 连上手机

**Android（推荐，能力最全）**：手机开 USB 调试插 Mac（或 `adb tcpip 5555` 后走 WiFi），然后：

```bash
PHONE_DRIVER=adb bun run --cwd packages/phone-agent src/cli.ts status
# adb 不在 PATH 时：PHONE_ADB_PATH=$HOME/Library/Android/sdk/platform-tools/adb
```

**iOS**：需要在 iPhone 上跑 WebDriverAgent（一次性设置）：

1. Xcode 打开 WebDriverAgent 工程（Appium WDA 或 facebook-WebDriverAgent），Team 选你的开发者账号，签到自己手机；
2. Xcode 里 Product → Test 启动 WDA（或 `xcodebuild test` 后台跑）；
3. 手机插着 USB 时：`brew install libimobiledevice && iproxy 8100 8100`；
4. 验证：`PHONE_DRIVER=wda bun run --cwd packages/phone-agent src/cli.ts status`

### 2. 注册给 CA agent（MCP）

本包的 MCP server 与 core 手写的 MCPClient 协议兼容（newline-delimited JSON-RPC 2.0 / stdio）。在 AgentRoam 桌面端/Web 的 MCP 管理里添加，或直接调服务端 API：

```bash
curl -s -X POST http://127.0.0.1:3000/api/mcp/connect \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:3000' \
  -d '{
  "id": "phone",
  "name": "手机操作",
  "transport": "stdio",
  "command": "'"$HOME"'/.bun/bin/bun",
  "args": ["run", "--cwd", "<本仓库绝对路径>/packages/phone-agent", "src/cli.ts", "mcp"]
}'
# 成功返回 {"status":"connected","tools":{...}}；spawn bun ENOENT 时用 bun 绝对路径
```

> 生产用先 `bun run --cwd packages/phone-agent build`，然后 `command: "node"`，
> `args: ["<绝对路径>/packages/phone-agent/dist/cli.js", "mcp"]`。

注册后 agent 里就多了一批 `mcp_phone_*` 工具，直接对 agent 说：

> 「打开淘宝搜 AirPods Pro 2，记下第一个结果的价格；再去京东搜同款对比，告诉我哪边便宜。」

### 3. 语音唤醒（可选）

前提：voice-service 模型齐全（本机已装好 ASR/KWS/TTS，`curl http://127.0.0.1:17863/health` 应全 true）、agent 服务端在 :3000、且模型路由在线（server 默认走 AI Hub 桌面端，桌面 App 在线即可；离线时会报「AI Hub 桌面端离线」）。然后：

```bash
brew install ffmpeg   # 采集麦克风
bun run --cwd packages/phone-agent voice
# [voice] 唤醒词 "小智" | agent=http://127.0.0.1:3000 | voice=ws://127.0.0.1:17863
# [voice] 待命中，说"小智"开始…
```

说「小智，帮我对比一下淘宝和京东的 AirPods Pro 2 价格」→ 网关把转写文本交给 CA agent
（会话 `phone-butler`，历史可跨次延续）→ agent 驱动手机干活 → 最终回答由 TTS 念出来。

不想接麦克风时可以先单条调试：`bun run --cwd packages/phone-agent voice -- --once "打开设置"`。
桌面端已有完整语音链路（唤醒→聊天），也可以直接在桌面聊天里说同样的话，效果一致。

## 工具清单（注册后带 `mcp_phone_` 前缀）

| 工具 | 作用 |
|---|---|
| `phone_status` | 连接状态、屏幕尺寸、当前前台 App |
| `phone_ui_tree` | 当前屏幕可交互元素文本树（带 `[序号]`，主感知通道） |
| `phone_screenshot` | 截图存盘；配了视觉模型可让模型描述截图 |
| `phone_tap` | 按 `[序号]` 或坐标点按；支付/密码类按钮需 `user_approved=true` |
| `phone_swipe` | 上下左右滑动或精确坐标滑动 |
| `phone_input_text` | 输入文本（iOS 支持中文；Android 仅 ASCII，见限制） |
| `phone_press_key` | back / home / enter / recent |
| `phone_launch_app` | 中文名或包名启动 App（映射在 `apps.json`，可自行补充） |
| `phone_list_apps` | 可用 App 列表 |
| `phone_wait` | 等页面加载 |
| `phone_shell` | （Android，`PHONE_ALLOW_SHELL=1` 才开启）adb shell 透传，做系统能力 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PHONE_DRIVER` | `auto` | `auto` / `adb` / `wda` |
| `PHONE_ADB_PATH` | 自动探测 | adb 二进制路径 |
| `PHONE_ADB_SERIAL` | 默认设备 | 多设备时指定 `-s` 序列号 |
| `PHONE_WDA_URL` / `PHONE_WDA_PREFIX` | `http://127.0.0.1:8100` / 空 | WDA 地址；老版 Appium WDA 设 `PHONE_WDA_PREFIX=/wd/hub` |
| `PHONE_ARTIFACTS_DIR` | 系统临时目录 | 截图保存目录 |
| `PHONE_VISION_BASEURL` / `PHONE_VISION_APIKEY` / `PHONE_VISION_MODEL` | 空 | 可选视觉模型（OpenAI 兼容），截图→文字描述 |
| `PHONE_MAX_TREE_LINES` | 150 | UI 树最多行数 |
| `PHONE_ALLOW_SHELL` | 关 | 放开 `phone_shell` |
| `AGENT_SERVER_URL` | `http://127.0.0.1:3000` | 语音网关调的 agent 服务端 |
| `VOICE_SERVICE_URL` | `ws://127.0.0.1:17863` | voice-service 地址 |
| `PHONE_VOICE_WAKE_WORD` | `小智` | 唤醒词（需与 KWS 模型支持一致） |
| `PHONE_VOICE_SESSION` | `phone-butler` | 语音会话 sessionId |
| `PHONE_TTS_VOICE` | `Serena` | TTS 音色 |
| `PHONE_MIC` | `:0` | ffmpeg avfoundation 麦克风设备 |

## 已知限制（诚实清单）

- **Android 中文输入**：`adb shell input text` 不支持非 ASCII。查东西/比价场景可绕开（搜索框点开后很多 App 支持语音输入或联想）；彻底解决需装 ADBKeyboard 输入法（后续扩展点，接口已按此设计）。
- **iOS 范围**：WDA 只能操作「前台可见内容」——不能后台读通知、不能解锁屏幕（需保持亮屏解锁）、back 手势模拟不了；iOS 上建议主攻「打开 App → 看内容 → 汇报」类任务。系统级能力（发消息/定闹钟）在 iOS 上交给 Siri 更合适。
- **支付安全**：`phone_tap` 对支付/密码类按钮做了软拦截（必须 `user_approved=true`），但 agent 可以自行置位——真正的安全边界是**不要把支付密码/验证码场景交给全自动**，下单到收银台那一步停下来让人确认。
- **工具结果是纯文本**：CA agent 的 `ToolResult.content` 不带图，所以感知走「无障碍树 + 可选视觉描述」而不是直接把截图塞进对话；等 core 的 ToolResult 扩展 images 后，`phone_screenshot` 可以升级为直接回图。
- **界面变化**：无障碍树快照带 30s TTL，界面跳转后 agent 必须重新 `phone_ui_tree`，工具提示里已反复强调。

## 开发

```bash
bun run --cwd packages/phone-agent test   # vitest（解析/驱动参数/MCP 协议/工具行为）
bun run --cwd packages/phone-agent build  # tsc → dist/
```

冒烟（无手机也能跑）：`bun run --cwd packages/phone-agent src/cli.ts status` 会给出针对性提示。
