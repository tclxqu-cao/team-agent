# Agent SDK 设计：Web Component 嵌入式聊天组件

## 概述

将现有 Agent 项目的核心能力封装为框架无关的 Web Component SDK，使任意 Web 应用（React/Vue/原生 HTML）通过一行 `<agent-chat>` 自定义元素即可获得悬浮按钮 + 聊天框 + Agent 能力 + 服务端通信。Agent 运行时由 SaaS 托管服务提供，前端只负责 UI 和通信。

## 背景

当前项目是一个 Bun monorepo，包含三个包：

- `@agent/core` — 框架无关的领域核心（AgentBuilder、ReAct 循环、模型提供者、工具、MCP、技能、记忆、会话等）
- `@agent/desktop` — Electron + React 桌面应用，通过 IPC 通信
- `@agent/server` — Next.js API 服务器，通过 HTTP + SSE 通信

目标是将 Agent 能力以 SDK 形式提供给第三方 Web 项目使用，而无需每个项目自己搭建 Agent 运行时。

## 需求约束

| 维度 | 选择 | 理由 |
|------|------|------|
| 宿主类型 | Web 应用（React/Vue/原生 HTML） | 最大兼容性 |
| 后端模式 | SaaS 托管服务 | 导入方无需部署后端 |
| UI 范围 | 悬浮按钮 + 聊天框 | 最小可用，配置由托管后台管理 |
| 技术形态 | Web Component（框架无关自定义元素） | 一行嵌入，Shadow DOM 隔离 |
| 认证方式 | 简单 Token | 先跑起来，后续可扩展 OAuth |

## 技术选型

### 方案对比

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **A. Lit Web Component（选定）** | 用 Lit 重写聊天 UI 为 Web Component | 真正框架无关，Lit ~5KB，Shadow DOM 隔离 | 需重写 UI 组件 |
| B. React-to-Web-Component 桥接 | 用 react-to-webcomponent 包装现有 React 组件 | 复用现有代码 | 包体积大（~40KB），Shadow DOM 兼容问题 |
| C. Stencil 编译器 | 用 Stencil 构建并输出多框架绑定 | 一次编写多输出 | 工具链重，学习成本高 |

**选择方案 A**，理由：UI 范围小（仅聊天框），重写成本低；Lit 是 Web Component 生态最成熟的库；当前 UI 用内联样式，设计可移植。

## 架构设计

### 整体结构

在现有 monorepo 中新增 `packages/sdk`，不改动 core/desktop，server 做小幅扩展。

```
packages/
├── core/          # 现有，不改（服务端 Agent 运行时）
├── server/        # 现有，小幅扩展（Token 认证 + CORS）
├── desktop/       # 现有，不改
└── sdk/           # 新增 — Web Component SDK
    ├── src/
    │   ├── client/          # 通信层（HTTP + SSE）
    │   │   ├── AgentClient.ts
    │   │   └── types.ts
    │   ├── components/      # Lit Web Components
    │   │   ├── AgentChat.ts      # <agent-chat> 主容器
    │   │   ├── AgentFab.ts       # <agent-fab> 悬浮按钮
    │   │   ├── ChatMessage.ts    # 消息气泡
    │   │   ├── ChatInput.ts      # 输入区
    │   │   ├── ToolCallCard.ts   # 工具调用展示
    │   │   └── AskUserCard.ts    # 用户交互卡片
    │   ├── store/
    │   │   └── ChatStore.ts      # 轻量响应式 store
    │   ├── styles/
    │   │   └── theme.ts          # CSS 变量主题
    │   └── index.ts          # defineCustomElements()
    └── dist/                # ESM + UMD + CDN 脚本
```

### 核心设计原则

- SDK 完全自包含，不依赖 core/desktop 的任何代码
- 通信层与 UI 层解耦：`AgentClient` 负责 HTTP/SSE，组件只消费数据
- Shadow DOM 隔离样式，不影响宿主页面
- 通过 `<agent-chat token="xxx" server="https://...">` 一行嵌入

## 通信层设计

### API 契约

复用现有 server 路由，新增 2 个端点：

| 端点 | 方法 | 用途 | 现有？ |
|------|------|------|--------|
| `/api/sessions` | POST | 创建会话 | ✅ |
| `/api/sessions` | GET | 列出会话 | ✅ |
| `/api/agent/run` | POST | 发送消息，启动 Agent | ✅ |
| `/api/agent/stream` | GET | SSE 流式接收事件 | ✅ |
| `/api/agent/abort` | POST | 中止当前运行 | ✅ |
| `/api/agent/answer` | POST | 回答 ask_user 问题 | 🆕 新增 |
| `/api/auth/verify` | GET | 验证 Token 有效性 | 🆕 新增 |

### AgentClient

```typescript
class AgentClient {
  constructor(config: {
    server: string;      // 托管服务地址
    token: string;       // 认证 Token
  })

  // 会话管理
  createSession(title?: string): Promise<Session>
  listSessions(): Promise<Session[]>

  // 核心交互
  run(input: string, sessionId: string): Promise<void>
  stream(sessionId: string): AsyncIterable<AgentEvent>  // SSE → async iterator
  abort(sessionId: string): Promise<void>
  answerQuestion(questionId: string, answer: string): Promise<void>

  // 事件订阅
  onEvent(callback: (event: AgentEvent) => void): () => void
}
```

### 事件流映射

SSE 收到的 `AgentEvent` 映射到 UI 状态变更：

| 事件类型 | UI 行为 |
|----------|---------|
| `text_chunk` | 追加流式文本到当前消息 |
| `thinking` | 显示"思考中"指示器 |
| `tool_call` | 渲染工具调用卡片（折叠态） |
| `tool_result` | 更新工具调用卡片结果 |
| `ask_user` | 渲染用户交互卡片（选项/输入） |
| `todo_update` | 更新待办列表（可选显示） |
| `done` | 标记完成，停止流式 |
| `error` | 显示错误信息 |

### SSE 重连策略

- 连接断开时自动重连（指数退避：1s → 2s → 4s → 8s，最大 30s）
- 重连后从最后一个 `done` 事件之后恢复
- 最多重试 5 次，超出后提示用户"连接已断开"

### 认证

所有请求头携带 `Authorization: Bearer <token>`。服务端新增中间件校验 Token，无效则返回 401。

## UI 组件层

### 组件层级

```
<agent-chat>          ← 唯一公开自定义元素
├── AgentFab          ← 悬浮按钮（内部组件）
├── ChatPanel         ← 聊天面板容器
│   ├── PanelHeader       ← 标题 + 关闭按钮
│   ├── MessageList       ← 消息滚动列表
│   │   └── ChatMessage   ← 单条消息
│   │       ├── 文本内容
│   │       ├── ToolCallCard   ← 工具调用（可折叠）
│   │       └── AskUserCard     ← 用户交互（选项/输入）
│   ├── TypingIndicator    ← 流式打字指示器
│   └── ChatInput          ← 输入框 + 发送按钮
```

只有 `<agent-chat>` 注册为自定义元素，其余是内部 Lit 组件，不暴露到全局。

### `<agent-chat>` 属性

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `token` | string | 必填 | 认证 Token |
| `server` | string | 必填 | 托管服务地址 |
| `position` | `"bottom-right"` \| `"bottom-left"` | `bottom-right` | 悬浮按钮位置 |
| `theme` | `"light"` \| `"dark"` \| `"auto"` | `auto` | 主题，auto 跟随系统 |
| `title` | string | `"AI 助手"` | 面板标题 |
| `placeholder` | string | `"输入消息..."` | 输入框占位符 |
| `session-id` | string | — | 恢复指定会话，不传则自动创建 |

### 交互流程

1. 用户点击 FAB → 面板展开
2. 首次打开 → `createSession()` → 存 sessionId
3. 用户输入消息 → `client.run(input, sessionId)`
4. SSE 事件流 → ChatStore 更新 → 组件响应式渲染
   - `text_chunk` → 实时追加文字（流式效果）
   - `tool_call` → 插入工具卡片（折叠态）
   - `tool_result` → 展开卡片显示结果，2s 后自动折叠
   - `ask_user` → 渲染交互卡片，用户选择后调 `answerQuestion()`
   - `done` → 停止 TypingIndicator，恢复输入框
5. 用户点击 FAB → 面板收起（保留会话状态）

### 状态管理（ChatStore）

轻量响应式 store，不引入外部状态库：

```typescript
class ChatStore {
  messages: ChatMessage[]      // 消息列表
  isRunning: boolean           // 是否正在运行
  isPanelOpen: boolean         // 面板是否展开
  currentStreamText: string    // 当前流式文本缓冲
  error: string | null         // 错误信息

  subscribe(callback: () => void): () => void
  addMessage(msg: ChatMessage): void
  appendStreamText(text: string): void
  setRunning(running: boolean): void
  togglePanel(): void
}
```

组件通过 Lit 的响应式属性订阅 store 变更，自动触发重渲染。

### 视觉设计

沿用当前项目的 Pearl Light 设计系统：
- CSS 变量定义在 Shadow DOM `:host` 上（`--accent`, `--bg-surface`, `--border-subtle` 等）
- `theme="auto"` 通过 `prefers-color-scheme` 媒体查询切换
- 悬浮按钮：圆形/圆角方形，accent 色，带呼吸动画
- 面板：圆角卡片，毛玻璃背景（`backdrop-filter: blur`），最大高度 70vh

## 后端扩展

现有 `@agent/server` 需要小幅扩展以支持 SaaS 模式。

### 新增内容

**1. Token 认证中间件**

```typescript
// packages/server/app/api/_middleware.ts
export function withAuth(handler: Function) {
  return async (request: Request) => {
    const token = request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token || !isValidToken(token)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(request);
  };
}
```

Token 存储在 SQLite 的 settings 表中（复用现有 `SQLiteSettingsStore`），验证逻辑简单查表。Token 的创建和管理（如生成、吊销、列表）由托管服务后台管理界面处理，本次设计不含 Token 管理后台的开发。

**2. CORS 支持**

在 `next.config.js` 中添加 CORS headers，允许跨域请求。预检 OPTIONS 请求直接返回 204。

**3. 新增 `/api/agent/answer` 路由**

接收 `{ questionId, answer, selectedIndices }`，调用 `agentHost.answerQuestion()`。需要在 server 的 `agent-host.ts` 中补全 `answerQuestion` 方法（参考 desktop 版本的 `QuestionManager`）。

**4. 新增 `/api/auth/verify` 路由**

SDK 初始化时调用此端点验证 Token，返回 `{ valid: boolean, project: string }`。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/server/app/api/_middleware.ts` | 新增 | Token 认证中间件 |
| `packages/server/next.config.js` | 修改 | 添加 CORS headers |
| `packages/server/app/api/agent/answer/route.ts` | 新增 | 回答 ask_user 问题 |
| `packages/server/app/api/auth/verify/route.ts` | 新增 | Token 验证 |
| `packages/server/app/api/agent-host.ts` | 修改 | 补全 `answerQuestion` 方法 |
| 现有 API 路由 | 修改 | 包裹 `withAuth()` |

**不改动** `@agent/core` 和 `@agent/desktop`。

## 构建与分发

### 构建配置

SDK 使用 Vite 库模式构建：

```typescript
// packages/sdk/vite.config.ts
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'umd'],
      fileName: (format) => `agent-sdk.${format}.js`,
    },
    rollupOptions: {
      external: ['lit'],
      output: {
        globals: { lit: 'Lit' },
      },
    },
  },
});
```

### 输出产物

```
packages/sdk/dist/
├── agent-sdk.es.js       # ESM（npm import）
├── agent-sdk.umd.js      # UMD（CDN <script>，含 Lit，~20KB gzip）
└── agent-sdk.d.ts        # TypeScript 类型声明
```

### package.json

```json
{
  "name": "@agent/sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/agent-sdk.umd.js",
  "module": "./dist/agent-sdk.es.js",
  "types": "./dist/agent-sdk.d.ts",
  "exports": {
    ".": {
      "import": "./dist/agent-sdk.es.js",
      "require": "./dist/agent-sdk.umd.js",
      "types": "./dist/agent-sdk.d.ts"
    }
  },
  "dependencies": {
    "lit": "^3.2.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "typescript": "^5.6.0"
  }
}
```

### 分发渠道

| 渠道 | 用途 | 引入方式 |
|------|------|----------|
| npm 私有源 | 内部项目使用 | `npm install @agent/sdk` → `import '@agent/sdk'` |
| CDN 脚本 | 外部项目快速接入 | `<script type="module" src="https://cdn.../agent-sdk.umd.js">` |

### 开发工作流

在 monorepo 中，SDK 作为新 workspace：

- `bun run dev:server` — 启动后端 API（含 CORS + Token 认证）
- `bun run dev:sdk` — Vite dev server，提供 SDK 开发预览页面
- 预览页面是简单 HTML，嵌入 `<agent-chat>` 用于实时调试

## 使用示例

### CDN 方式

```html
<script type="module" src="https://cdn.your-domain.com/agent-sdk.umd.js"></script>

<agent-chat
  token="your-project-token"
  server="https://api.your-domain.com"
  position="bottom-right"
  theme="auto"
></agent-chat>
```

### npm 方式

```typescript
import '@agent/sdk';

// 或程序化 API
import { defineCustomElements } from '@agent/sdk';
defineCustomElements();

const chat = document.createElement('agent-chat');
chat.setAttribute('token', 'your-token');
chat.setAttribute('server', 'https://api.your-domain.com');
document.body.appendChild(chat);
```

## 明确不包含的内容（YAGNI）

- 不做框架适配包（React wrapper / Vue wrapper）— Web Component 原生可在所有框架中使用
- 不做 i18n 国际化 — 先中文，后续按需加
- 不做自定义主题编辑器 — 只支持 light/dark/auto 三种预设
- 不做离线模式 / PWA — 依赖在线 SaaS 服务
- 不做端到端加密 — 先用 HTTPS + Token 保证基本安全
