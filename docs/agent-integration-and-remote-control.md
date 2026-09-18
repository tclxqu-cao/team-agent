# Agent 接入与远程控制架构（Codex / Claude Code / OpenCode）

> 更新时间：2026-09-16 ｜ 基于 `master` 分支当前代码
> 定位：说明 AgentRoam 如何以编程方式接入外部编码 Agent（运行时适配器），以及远程设备（手机/浏览器）如何通过隧道控制本地 Agent 进程。内置 customer-agent 引擎本身见 `docs/core-technology.md`；安装与配对操作步骤见 `docs/agentroam-operation-guide.md`。

## 1. 总览

核心结论：**四类 Agent 共享同一条远程控制链路，差异只在最底层的"适配器"**。

```
手机 / 浏览器（webapp PWA / 移动端）
   │  HTTPS + SSE（公网 URL，配对 token 鉴权）
   ▼
cloudflared / pinggy 出站隧道 ◄── packages/cli（agentroam 启动器）
   ▼
packages/server（Next.js API + ws-server.mjs）
   │  HTTP / SSE / WS   ⇄   Unix socket（native-runtime.sock）
   ▼
NativeRuntimeBroker（谁持有 socket 谁是 host）
   │  统一适配器 AgentRuntimeAdapter
   ├── codex-runtime-adapter        ──spawn───► codex app-server --stdio（JSON-RPC）
   ├── claude-runtime-adapter       ──进程内───► @anthropic-ai/claude-agent-sdk query()
   ├── opencode-runtime-adapter     ──HTTP────► opencode 本地 server
   └── customer-agent-runtime-adapter ─进程内──► core AgentLoop（自研 ReAct）
```

接入方式有两类：Codex 靠官方 CLI 的 `app-server` 子命令（子进程 + JSON-RPC）；Claude Code 靠官方 Agent SDK（进程内调用，SDK 内部自行管理引擎子进程）。接入之后，会话管理、事件流、远程控制全部统一。

## 2. 统一运行时接口

`packages/desktop/main/agent-runtime/types.ts` 定义 `AgentRuntimeAdapter`，`agentType` 取值 `"customer-agent" | "codex" | "claude-code" | "opencode"`。

适配器把各 Agent 的原生 API 翻译成同一套抽象：

- 会话：列表 / 读取 / 启动 / 恢复（resume）/ 分叉（fork）/ 归档；
- 运行：startRun 产出流式事件（带 `runId` / `sequence`）；
- 交互：steer（运行中注入消息）、abort、审批问答（answer）；
- 其他：权限模式切换、goal 队列、外部会话导入（磁盘扫描）。

上层（server、webapp）只消费这套抽象，不感知底层是 JSON-RPC 还是 SDK。

## 3. 各运行时接入方式

### 3.1 Codex — 子进程 + JSON-RPC（`codex app-server --stdio`）

- 实现文件：`packages/desktop/main/agent-runtime/codex-app-server-client.ts`（协议客户端）、`codex-runtime-adapter.ts`（适配器）。
- 启动：`spawn(executable, ["app-server", "--stdio"])`，Codex CLI 自带的 `app-server` 模式在 stdin/stdout 上跑**换行分隔的 JSON-RPC**。
- 握手：先发 `initialize`（声明 `clientInfo` 与 `experimentalApi` 能力），再发 `initialized` 通知。
- 会话 API：`thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`thread/archive`、`model/list`、`thread/goal/set`。
- 审批：`applyPatchApproval` / `execCommandApproval` 是服务端→客户端的反向请求，适配器把它们转成统一问答推给前端。
- 外部会话：直接读 `~/.codex` 下的 rollout JSONL（`codex-rollout-activity.ts`、`codex-session-disk-catalog.ts`），终端里自己开的 codex 会话也能显示。
- 二进制托管：`packages/cli/src/codex-runtime-manager.ts` 钉死 `@openai/codex@0.153.0`（`CODEX_RUNTIME_VERSION`），解析顺序：显式指定 → 全局 PATH → 托管安装（`dataDir/runtimes/codex/<版本>`）。可用 `AGENT_CODEX_BIN` 覆盖。

### 3.2 Claude Code — 官方 Agent SDK（进程内 `query()`）

- 实现文件：`packages/desktop/main/agent-runtime/claude-runtime-adapter.ts`。
- **不 spawn、不手写协议**：直接 import `@anthropic-ai/claude-agent-sdk` 的 `query()`。拉起 Claude Code 引擎子进程、流式 JSON 通信都由 SDK 内部完成（`sdk.mjs` 内部依赖 `node:child_process`）。
- 关键参数：
  - `resume: nativeSessionId` — 会话续聊；
  - `includePartialMessages: true` — 流式增量输出；
  - `permissionMode: "bypassPermissions" | "default"`；
  - `canUseTool` 回调 — 工具权限确认转成统一"提问"（问题 ID 形如 `claude:<sessionId>:<requestId>`）；
  - `tools: { type: "preset", preset: "claude_code" }` + `skills: "all"`。
- 子代理活动由 `ClaudeSubagentTracker` 跟踪。
- 外部会话：扫描 `~/.claude/projects` 磁盘文件；诊断用 `claude --version`、`claude agents --json --all`。
- 前置条件：本机需已安装 Claude Code CLI（无托管安装，与 Codex 不同）。

### 3.3 Codex 与 Claude Code 接入差异对照

| 维度 | Codex | Claude Code |
|---|---|---|
| 驱动方式 | spawn 子进程 `codex app-server --stdio` | 进程内调 SDK `query()` |
| 协议 | 手写 JSON-RPC（握手 / thread API / 反向审批请求） | 不手写，SDK 内部封装 |
| 会话续聊 | `thread/resume` | `query({ resume })` 选项 |
| 权限确认 | `applyPatchApproval` / `execCommandApproval` 反向请求 | `canUseTool` 回调 |
| 流式输出 | thread 事件流 | `includePartialMessages: true` |
| 二进制管理 | CLI 托管安装，钉版本 0.153.0 | 依赖本机已装 `claude` CLI |
| 外部会话来源 | `~/.codex` rollout JSONL | `~/.claude/projects` |

### 3.4 OpenCode — 本地 HTTP

`opencode-server-client.ts` + `opencode-runtime-adapter.ts`：对本地 opencode server 发 HTTP 请求。可用 `AGENT_OPENCODE_BIN` 覆盖可执行文件。适配器在 `native-runtime-broker.ts` 的 `createNativeRuntimeBrokerHostRuntime` 中与 Codex / Claude 一起组装。

### 3.5 customer-agent — 内置 ReAct 引擎

`packages/core/src/domain/agent/AgentLoop.ts` + `AgentBuilder.ts`：纯自研循环（流式模型调用、tool_calls、AutoCompact），模型走 `ModelRegistry` 注册的 Anthropic / OpenAI / DeepSeek / AiHub Provider。它也被包成 `customer-agent-runtime-adapter.ts` 接入同一体系。**不走 broker**——只有外部 CLI 运行时（codex / claude-code / opencode）由 broker 托管，customer-agent 在 server 的 `agent-host.ts` 内运行。

## 4. NativeRuntimeBroker：本地进程的所有者

实现：`packages/desktop/main/agent-runtime/native-runtime-broker.ts`。

- **Socket**：`~/.agentroam/native-runtime/native-runtime.sock`（`BROKER_SOCKET_NAME`），`chmod 0600`，单写者选举 + 陈旧 socket 清理。
- **自动升级 host**：任何进程 ping 不通 broker 时，自己启动 `NativeRuntimeBrokerHost` 接管——所以 codex/claude 子进程活在"持有 socket 的进程"里（Electron 主进程或无头 server）。server 侧 `packages/server/lib/native-runtime-service.ts` 注入该工厂作为兜底，并为 launchd 环境修复 PATH（`ensureNativeCliPath`），否则找不到 `codex` / `claude`。
- **客户端 API**：`NativeRuntimeBrokerClient` 提供 `create` / `fork` / `get` / `startRun` / `subscribe` / `steer` / `abort` / `answer` / `enqueueGoal` / `setPermissionMode` / `handoff`。
- **事件与快照**：订阅走独立 socket 连接，事件带 `runId` / `sequence`；新订阅者可从 broker 快照重放，支撑断线续看。

## 5. 远程控制链路（四类 Agent 完全一致）

### 5.1 启动与隧道

- `packages/cli/src/cli.ts`：`RuntimeManager` 用打包的 Node 运行时启动 `packages/server` 的 `ws-server.mjs`，然后 `selectRelay()` 开隧道。
- `packages/cli/src/tunnel/relay-orchestrator.ts`：`relay=auto` 时依次尝试 **cloudflare → pinggy**，失败或 `localOnly` 时回落局域网地址。cloudflared 二进制按平台打包在 `packages/cloudflared-*`，就绪探测见 `public-readiness.ts`。

### 5.2 配对与鉴权

一次性配对码 + 二维码（`device-pairing.ts`）换取设备 token，server 端校验；桌面与 server 之间通过 `~/.agentroam/services` 下带 token 的描述文件互相发现（`packages/server/lib/desktop-discovery.mjs`）。

### 5.3 会话流（HTTP + SSE）

- webapp 调 `POST /api/agent/run` 发指令，`GET /api/agent/stream` 收 SSE 事件流，另有 `/steer`、`/abort`、`/answer`（`packages/webapp/src/infrastructure/http/agent-http-gateway.ts`）。
- server 按**会话 ID 前缀**路由（`packages/server/app/api/agent/run/route.ts`）：native 会话（codex / claude-code / opencode）走 broker，其余走 customer-agent 的 agentHost；native 事件经 `agentHost.publishExternal` 对外复用。
- SSE 帧带 `id: runId:sequence` 游标（`packages/server/app/api/agent/stream/route.ts`），重连时按游标续传或从快照重放。

### 5.4 断线续跑

goal 与排队消息保存在 broker 侧（`enqueueSessionGoal` 等队列机制），手机断开后会话继续运行；换设备通过 `handoff` / snapshot 接着看，不丢进度。

### 5.5 同一隧道上的其他控制面

- **Web 终端**：`packages/server/ws-server.mjs` 在同端口复用 WebSocket——二进制帧即 PTY 原始字节，JSON 文本帧是控制命令；`node-pty` 会话跨重连常驻，写入有单写者锁（`EWRITELOCK`）。置顶快捷命令默认就是 `codex`、`claude agents`、`opencode`、`agent-tui`（`packages/core/src/domain/web-console/pinned-commands.ts`）——手机终端里可直接驱动这些 CLI。
- **Live view / 远程桌面**：`LiveViewRegistry` + `browser:watch/takeover/input/webrtc` 协议（`packages/core/src/domain/web-console/WebBrowserBridge.ts`）；远程桌面含授权流程、WebRTC 视频与 macOS 辅助权限（`packages/server/lib/remote-control/`）。
- **AI Hub relay**（独立机制）：把真实 AI 网页对话当作模型提供方，桌面端通过内嵌浏览器驱动，三端共享线路协议 `packages/core/src/domain/ai-hub/relay-protocol.ts`（Unix socket `ai-hub-relay.sock`）。

## 6. 分层职责

| 层 | 职责 |
|---|---|
| `packages/core` | 领域层：AgentLoop / AgentBuilder、Tool / Skill / Model 注册表、SQLite 存储、SSE 帧协议、web-console / live-view / ai-hub 契约（无 UI） |
| `packages/desktop` | `main/agent-runtime/*`：运行时适配器 + broker（真正 spawn codex、调 claude SDK 的地方）；Electron IPC、语音、AI Hub |
| `packages/server` | Next.js API + ws-server.mjs：HTTP / SSE / WS(PTY) / 配对 / 远程控制；无头时托管 broker |
| `packages/cli` | `agentroam` 启动器：平台运行时与 codex 托管安装、隧道、launchd 服务化、配对码 |
| `packages/webapp` / `mobile` / `sdk` / `tui` | 远程客户端：PWA / 移动端（HTTP+SSE）、嵌入式聊天组件、终端 UI |
| `packages/cloudflared-*` / `runtime-*` / `tui-*` | 预编译平台二进制（cloudflared、Node 22、TUI） |

## 7. 相关文档

- `docs/core-technology.md` — 内置 customer-agent 引擎（AgentLoop / 工具 / 模型 / 技能）。
- `docs/agentroam-operation-guide.md` — 安装、多设备配对、远程授权操作步骤。
- `docs/superpowers/specs/` — native-runtime-broker 权限、托管 codex 运行时、隧道 CLI、统一本地会话、live-follow 等设计文档。
