# AgentRoam

AgentRoam 把本机的 AI Agent、终端、文件和桌面放进同一个工作台。你可以在桌面端开始任务，再从浏览器、手机或平板继续同一条会话；也可以直接接管终端和桌面，不必一直守在电脑前。

它不是一个只负责转发消息的聊天壳。AgentRoam 统一管理会话、运行状态、历史记录、审批和任务队列，并把 Customer Agent、Codex、Claude Code、OpenCode、真实 Shell 与 AIHub 网页模型接到同一套界面中。

## 核心能力

### 统一会话：换设备，不换上下文

- **统一接入多种 Agent**：Customer Agent、Codex、Claude Code 和 OpenCode 使用同一套会话接口。上层界面不需要关心底层是 ReAct、JSON-RPC、Agent SDK 还是本地 HTTP。
- **自动汇总原生历史**：发现各运行时已有的项目与历史会话，按工作目录归入统一工作区。即使会话最初是在 Codex 或 Claude Code 终端里创建的，也能回到 AgentRoam 中查看和继续。
- **完整的会话操作**：支持创建、恢复、分叉、重命名、归档、停止、运行中追加消息、权限审批和目标队列。
- **桌面、Web、手机接续**：多个入口连接同一个本地服务。页面断开不会自动终止正在执行的任务，重新连接后可以从事件快照和历史记录继续查看进度。
- **统一但不抹平差异**：每种 Agent 仍保留自己的模型、权限模式、工具事件和原生会话能力，AgentRoam 负责把它们整理成一致的操作体验。

### 远程终端：历史命令直接复用

AgentRoam 提供真实 PTY 终端和文件树，可在浏览器或手机上操作本机项目。终端支持多页签、工作目录跟随、断线重连、复制粘贴和移动端触控。

Shell 命令会在执行结束后自动进入历史记录，并保存工作目录、执行时间和退出状态。历史面板支持：

- 搜索、复制、删除历史命令；
- 点击历史项，把完整命令直接填回当前终端；
- 把常用命令置顶，之后单击即可执行；
- 新增、编辑、删除和拖动排序置顶命令；
- 默认提供 `codex`、`claude agents`、`opencode`、`agent-tui` 快捷入口。

常用的启动、构建、测试和运维命令不需要每次重新敲，也不需要在手机键盘上逐字输入。

### 远程桌面：从“看见”到“操作”

远程桌面使用 WebRTC 传输实时画面，并保留 JPEG 降级通道。完成设备配对和系统授权后，可以从 Web/PWA 查看并控制运行 AgentRoam 的电脑。

- 鼠标、键盘、触控、右键、拖动、快捷键和移动端软键盘；
- 多显示器切换，流畅 / 高清 / 原画三档画质；
- 全屏、手机横屏、画面缩放与双指手势；
- 控制权互斥，观看者不会同时抢占鼠标和键盘；
- macOS 14+ Apple Silicon 与 Windows 10/11 x64 原生远控链路；
- 当前控制者可开启双向语音：听到电脑系统声音，也能把手机或浏览器麦克风播放到电脑，并分别静音麦克风和扬声器。

远程桌面需要被控电脑保持在线，并授予对应的屏幕采集和输入控制权限。双向语音只在控制页面位于前台且当前设备持有控制权时工作。

### AIHub：网页模型也能进入 Agent Loop

AIHub 把已经登录的 AI 网页集中到 AgentRoam。当前内置 DeepSeek、Gemini、ChatGPT 和 Grok，也支持配置自定义站点。

- **多模型对比**：一次选择多个站点，同步发送文本或图片，并在同一工作台查看结果。
- **复用网页登录态**：由桌面端驱动真实浏览器页面，不要求为 AIHub Provider 再填写 API Key。
- **作为 Agent 模型使用**：AIHub 不只是一个网页分屏。它可以作为 Customer Agent 的模型 Provider，接收系统提示、会话历史、当前工作目录和最新消息，再把网页回复送回统一会话。
- **支持工具闭环**：网页模型可以通过受控 JSON 协议产生标准 `tool_call`，由 Agent Loop 执行 Bash、文件、Skill 等已注册工具，再把工具结果送回网页模型继续完成任务。
- **长回答恢复**：持续检测网页生成状态和“继续生成”，避免把思考过程、半截回答或未完成的工具调用误当成最终结果。

AIHub 的自动注入、回复抓取和 Agent Provider 能力需要桌面 App 在线，并且目标站点已经登录。

## 其他能力

- **文件工作区**：浏览目录、预览和编辑文件，终端与文件树共享当前项目上下文。
- **工具与扩展**：内置文件、搜索、代码编辑和 Shell 工具，支持 MCP、Skills 和 Plugins。
- **任务连续运行**：流式事件、审批、运行中追加消息、目标队列和断线恢复共同保证长任务可以持续执行。
- **安全远程访问**：一次性配对码、设备授权、可撤销 Token、HTTPS 隧道和终端单写者锁。
- **本地服务常驻**：macOS LaunchAgent 与 Windows Task Scheduler 可在登录后自动启动并在异常退出后恢复。

## 快速开始

### 环境要求

- Node.js `>= 22.22.0`
- macOS Apple Silicon，或 Windows 10/11 x64

直接启动当前 preview 版本：

```bash
npx agentroam@preview
```

首次启动会尝试建立 Cloudflare 或 Pinggy HTTPS 隧道，并在终端显示访问地址、二维码和配对信息。手机扫码并完成一次性配对后，即可打开 Web 控制台。

常用命令：

```bash
agentroam service status   # 查看后台服务、访问地址和授权入口
agentroam service url      # 查看当前访问地址
agentroam pair             # 为新手机或浏览器生成一次性配对
agentroam devices          # 查看已授权设备
agentroam service restart  # 重启后台服务
agentroam service logs     # 查看服务日志
```

需要安装为后台服务，或配置多设备、远程桌面权限时，请阅读 [AgentRoam 操作指南](docs/agentroam-operation-guide.md)。

## 工作方式

```text
桌面 App / Web / PWA / 手机
              |
      HTTP + SSE + WebSocket
              |
       AgentRoam 本地服务
        /        |        \
统一 Agent 会话  PTY/文件   远程桌面/AIHub
        |
Customer Agent / Codex / Claude Code / OpenCode
```

`UnifiedSessionService` 和 Native Runtime Broker 负责统一发现、运行和恢复各类 Agent 会话；WebSocket 服务承载 PTY、文件控制、AIHub 中继和远程桌面信令；桌面端保留浏览器登录态、系统权限和其他设备原生能力。

## 本地开发

开发环境还需要 Bun。安装依赖后，可以一次启动 Core、Server 和 Desktop：

```bash
bun install
bun run dev
```

也可以分别启动：

```bash
bun run dev:server
bun run dev:desktop
bun run dev:webapp
```

验证与构建：

```bash
bun test
bun run lint
bun run build
```

## 主要目录

| 目录 | 职责 |
| --- | --- |
| `packages/core` | Agent Loop、模型、工具、Skill、会话与远控领域协议 |
| `packages/native-runtime` | Codex / Claude Code / OpenCode 适配器、统一会话与 Broker |
| `packages/server` | Next.js API、SSE、WebSocket PTY、配对、AIHub 中继与远程控制 |
| `packages/desktop` | Electron 桌面端、AIHub 浏览器、语音和系统原生能力 |
| `packages/webapp` | 会话 Web/PWA 客户端 |
| `packages/cli` | `agentroam` 安装器、后台服务、隧道与平台运行时管理 |
| `packages/tui` | 终端 Agent UI |

## 相关文档

- [安装、多设备配对与远程授权](docs/agentroam-operation-guide.md)
- [Agent 接入与远程控制架构](docs/agent-integration-and-remote-control.md)
- [核心技术说明](docs/core-technology.md)
- [CLI 使用与发布说明](packages/cli/README.md)
