# Customer Agent 核心技术文档

> 更新时间：2026-07-30 ｜ 基于 `master` 分支当前代码
> 定位：描述本项目当前的核心技术架构、关键模块与技术决策，作为开发与协作的入口文档。

## 1. 项目概览

Customer Agent 是一个 **TypeScript + Bun** 的 monorepo，实现了一个完整的 AI 智能体（Agent）平台，覆盖「核心引擎 → 服务端 API → 桌面客户端 → 嵌入式 SDK」四层交付形态。

```
customer-agent/
├── packages/core      # @agent/core    核心领域引擎（无 UI 依赖）
├── packages/server    # @agent/server  Next.js 14 API 服务（REST + SSE）
├── packages/desktop   # @agent/desktop Electron 32 桌面应用
└── packages/sdk       # @agent/sdk     Lit Web Components 嵌入式 SDK
```

依赖方向：`server` 与 `desktop` 都依赖 `core`；`sdk` 不依赖 `core`，通过 HTTP/SSE 与 `server` 通信。

### 技术栈一览

| 层面 | 选型 |
|---|---|
| 运行时 / 包管理 | Bun（workspaces） |
| 语言 | TypeScript 5.6+，target ES2022，module ESNext |
| 测试 | Vitest 2.1+（`bun run test`） |
| 类型检查 | `tsc --noEmit`（`bun run lint`） |
| 桌面端 | Electron 32 + Vite 5 + React 18 + Zustand |
| 服务端 | Next.js 14（App Router） |
| SDK | Lit 3.2 Web Components（UMD + ESM 双格式） |
| 持久化 | better-sqlite3（WAL 模式）+ 文件系统（JSON / Markdown） |
| 参数校验 | Zod |

## 2. 核心引擎（packages/core）

采用领域驱动设计，`src/domain/` 下按模块划分，`src/infrastructure/` 提供 SQLite 等基础设施实现。

### 2.1 Agent 循环（domain/agent）

- **`AgentLoop`**（`AgentLoop.ts`）：核心 ReAct 循环。流程：加载会话历史 → `ContextAssembler` 组装上下文 → 迭代（模型流式调用 → 解析 tool_calls → 工具并行执行 → 结果回注消息）。关键能力：
  - **AbortSignal 取消**：整个 run 与单个工具执行均可中止；
  - **AutoCompact 自动压缩**：token 占用超过 `maxTokens` 的 60%（`compactThreshold=0.6`）时触发；
  - **历史清洗**：`sanitizeHistory` 处理孤儿 tool_calls，避免不完整的调用对导致模型报错；
  - **steer / mailbox**：运行中可注入外部用户消息，转向当前任务。
- **`AgentBuilder`**：Builder 模式链式配置 `modelProvider`、`toolRegistry`、`sessionStore`、`memoryStore`、`skillLoader`、`maxIterations`、`enabledTools/Skills` 等，`build()` 产出 `AgentConfig` 并实例化 `AgentLoop`。
- **`ContextCompactor`**：两步压缩策略——
  1. `pruneToolResults`：截断旧工具结果（保留最近 6 条完整）；
  2. `compact`：调用模型生成摘要，重组为「system + 摘要消息对 + 最近 8 条消息」。
  压缩检查点以 `name=__compaction_checkpoint__` 消息持久化到会话中，下次 run 直接从检查点恢复。
- **`AgentEvent` 事件流**：统一的事件联合类型（`thinking` / `tool_call` / `tool_result` / `text_chunk` / `text_done` / `compacted` / `turn_aborted` / `error` / `done` / `todo_update` / `agent_dispatch` / `agent_done` / `agent_progress` / `cron_update` / `show_widget`），所有前端（desktop renderer、SDK）都消费同一套事件协议。

### 2.2 模型抽象（domain/model）

- **`IModelProvider`** 接口：`streamChat`（流式补全）、`countTokens`、`supportsModel`。
- 内置三个 Provider：**AnthropicProvider**、**OpenAIProvider**、**DeepSeekProvider**。
- **关键决策 — Anthropic 工具 Schema 直接透传**：`input_schema: t.parameters` 原样传递工具的 JSON Schema，**禁止**二次包装为 `{type:"object", properties, required: 所有key}`（那会把所有字段错误标记为必填并破坏原始 schema）。
- Anthropic 流式解析基于 SSE 事件（`content_block_start` / `content_block_delta` / `message_stop`）。

### 2.3 工具系统（domain/tool)

- **`ITool`** 接口：`name` / `description` / `parameters`（JSON Schema）/ `schema`（Zod）/ `execute`。
- **`registerBuiltinTools`** 注册 10 个基础工具：ReadFile、WriteFile、StrReplace、Bash、WebFetch、WebSearch、Grep、Glob、ApplyPatch、ShowWidget。
- 扩展工具按需手动注册：Todo 系列、DispatchAgent / WaitAgent（子 Agent）、AskUser、Cron 系列、Lsp 系列（Diagnostics / Hover / Definition / References）、RemoteProjectAction。
- **执行模型**：一轮内所有 tool_calls 通过 `Promise.allSettled` **并行执行**，单个失败不影响其他；每个工具接收 AbortSignal 支持取消。

### 2.4 上下文组装（domain/context）

**`ContextAssembler`** 负责拼装最终 system prompt，内置默认 ReAct 工作指引（强调最小化工具调用、精准编辑、批量操作）。核心是 **token 预算分配策略**：

- 先扣除固定成本（base prompt + 环境信息 + 用户消息 + 历史 + 500 安全余量）；
- 剩余预算按比例分配：**Tools 30% / Skills 15% / Memory 20% / Project 35%**；
- 各节按预算截断，未用完的盈余重新分配给最低优先级的 Project 段；
- 拼装顺序：base → env → project → skills → tools → memory。

### 2.5 协议客户端（domain/mcp、domain/lsp）

- **`MCPClient`**：Model Context Protocol 客户端，支持三种传输——stdio（子进程 + JSON-RPC）、SSE、streamableHttp；实现 connect / listTools / callTool / listResources / readResource。
- **`MCPManager`**：管理多个 MCP 连接，连接时自动将远端工具注册进 ToolRegistry（命名 `mcp_{serverId}_{toolName}`）。
- **`LSPClient` / `LSPManager`**：LSP JSON-RPC 客户端（stdio 传输），支持 initialize、diagnostics 推送、hover、definition、references；Manager 按语言/文件扩展名路由到对应 LSPClient 实例。

### 2.6 持久化与状态

| 模块 | 实现 | 存储位置 |
|---|---|---|
| 会话 | `SQLiteSessionStore`（生产）/ `FileSystemSessionStore` / `InMemorySessionStore` | `.agent-data/agent.db` |
| 数据库 | `SQLiteDatabase`（better-sqlite3 封装，WAL + 外键 + 自动迁移） | settings / projects / sessions / messages / events 等表 |
| 记忆 | `FileSystemMemoryStore`：每条记忆一个 `.md` 文件 + `MEMORY.md` 索引 | `memory/` |
| 定时任务 | `CronTasks`（JSON 持久化）+ `CronTaskLock`（文件锁）+ `cronParser` | `.agents/scheduled_tasks.json` |

### 2.7 技能与插件（domain/skill、domain/plugin）

- **`SkillLoader`**：以 `SKILL.md` 为标识，按优先级从多目录自动发现技能：项目 `.agent/skills/` → 全局 `~/.agent/skills/` → 第三方工具目录（`.claude` / `.cursor` / `.github` / `.codex` / `.copilot`），兼容主流 Agent 工具的技能生态。
- **`PluginManager`**：插件生命周期管理（load / activate / deactivate），插件通过 PluginAPI 注册工具与技能。

## 3. 服务端（packages/server）

- Next.js 14 App Router，API 全部位于 `app/api/`；模型配置通过环境变量（`AGENT_API_KEY` / `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID`）。
- **`agent-host.ts`**：服务端 AgentHost 单例，管理 Agent 生命周期、sessionStore、pendingQuestions。
- **流式方案**：SSE（`ReadableStream` + `text/event-stream`），客户端按 `sessionId` 订阅。
- 主要路由：

| 路由 | 职责 |
|---|---|
| `POST /api/agent/run` | 触发 Agent 运行 |
| `GET /api/agent/stream?sessionId=` | SSE 实时事件流 |
| `/api/agent/abort`、`/api/agent/answer` | 中止运行、回答 ask_user |
| `/api/sessions` | 会话 CRUD |
| `/api/mcp`、`/api/memory`、`/api/skills`、`/api/plugins`、`/api/tools`、`/api/remote-tools` | 各领域资源管理 |
| `/api/auth` | Token 验证 |

## 4. 桌面端（packages/desktop）

### 4.1 主进程（main/）

- **`index.ts`**：Electron 入口，创建 BrowserWindow（`contextIsolation` + `preload.cjs`），注册 `agent:run/abort/steer` 等 IPC handler；开发模式加载 `localhost:5173`，生产模式加载 `renderer-dist/index.html`。
- **`agent-host.ts`**：桌面端核心集成层，组合全部 SQLite Store（Settings / Session / Memory / MCP / Skill / Plugin / Upload / Project / Agent / LSP）+ CronScheduler + MCPManager + LSPManager + SubAgentDispatcher + QuestionManager。
- **`preload.ts`**：contextBridge 暴露 `window.agentApi`，覆盖 agent / settings / projects / sessions / memory / mcp / lsp / skills / upload / file 全部 IPC 接口。
- **`question-manager.ts`**：AskUser 工具的问答挂起/恢复管理；**`sub-agent-dispatcher.ts`**：子 Agent 并行派发。

### 4.2 渲染进程（renderer/）

React 18 + Zustand（`agentStore.ts` 管理 sessions / messages / streaming / todos / cronTasks），核心组件：`ChatView`（主聊天视图，含 markdown 与工具结果渲染）、`AskUserCard`、`ToolCallCard`，以及 AgentManager / MCPServerList / LSPServerList / SkillManager / MemoryViewer / SettingsPanel 等管理界面。

### 4.3 事件链路

```
ChatView → window.agentApi.run()
  → ipcRenderer.invoke("agent:run") → ipcMain.handle → AgentHost.run()
  → AgentBuilder 构建 → AgentLoop.run()（ReAct 循环）
  → AgentEvent → webContents.send("agent:event")
  → preload agentEventBus → agentStore → UI 更新
```

## 5. 嵌入式 SDK（packages/sdk）

- 基于 **Lit 3.2 Web Components**，`@customElement` 自注册，Vite library mode 输出 UMD + ESM。
- 导出能力：
  - **`<agent-chat>`**（AgentChat）：主聊天组件，接收 token 与 server URL；
  - **`<agent-fab>`**（AgentFab）：浮动入口按钮；
  - **`AgentClient`**：HTTP + SSE 客户端（verifyToken / createSession / send / connect 等）；
  - **`ChatStore`**：框架无关的轻量 pub/sub 响应式状态；
  - 共享类型：AgentEvent、ChatMessage、Session、ToolCall、AskUserQuestion、RemoteToolRegistration。

## 6. 开发与构建

### 常用命令（均在项目根目录执行）

```bash
bun run dev            # concurrently 启动 core + server + desktop
bun run dev:desktop    # 仅桌面端（必须在根目录执行，子目录会报 Script not found）
bun run build          # core → server → desktop 顺序构建
bun run test           # vitest run
bun run lint           # tsc --noEmit
```

### 桌面端 dev 启动流程

1. kill 占用 5173 端口的进程；
2. `tsc` 编译主进程 + `tsc -p tsconfig.preload.json` 编译 preload（CommonJS），产物 `mv` 为 `preload.cjs`；
3. `concurrently` 启动 Vite（5173）+ Electron。

### 已知坑点

| 问题 | 处理 |
|---|---|
| `bunx` 在线解析依赖卡死（网络不稳时卡在 `Resolving...`） | 改用本地二进制：根目录 `node_modules/.bin/tsc`、子包 `node_modules/.bin/{vite,electron}` 按上述流程手动执行 |
| Electron 启动报 better-sqlite3 `NODE_MODULE_VERSION` 不匹配 | `./node_modules/.bin/electron-rebuild -f -w better-sqlite3 -m packages/desktop` 重编译后重启 |
| core 打包误捆绑 native 模块 | 构建时 external `better-sqlite3` 与 `bindings` |

## 7. 关键技术决策汇总

1. **单核多壳**：core 无 UI 依赖，desktop（IPC 直连）与 server（HTTP/SSE）复用同一引擎；SDK 仅依赖 server 协议，四端共享 `AgentEvent` 事件协议。
2. **Anthropic 工具 schema 透传**：`input_schema: t.parameters` 直传，不二次包装（见 §2.2）。
3. **上下文预算制**：按 30/15/20/35 比例分配 Tools/Skills/Memory/Project，盈余下放最低优先级段（见 §2.4）。
4. **两步压缩 + 检查点持久化**：先剪工具结果再做摘要，检查点写入会话可跨 run 恢复（见 §2.1）。
5. **工具并行执行**：`Promise.allSettled` + AbortSignal，失败隔离、可取消（见 §2.3）。
6. **技能生态兼容**：SkillLoader 同时发现 `.agent`、`~/.agent` 及 `.claude`/`.cursor`/`.codex` 等第三方目录的 SKILL.md（见 §2.7）。
7. **持久化分层**：结构化数据走 SQLite（WAL），记忆走 Markdown 文件，定时任务走 JSON + 文件锁（见 §2.6）。
