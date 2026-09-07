

# Team Agent - 多模态智能 Agent 运行时平台

## 项目简介

Team Agent 是一个企业级多模态智能 Agent 运行时平台，支持多种 Agent 运行时（Customer Agent、Codex、Claude Code 等），提供统一的会话管理、本地/远程运行时支持、语音交互、终端/Web/桌面多端适配等能力。平台采用模块化架构设计，支持跨平台部署，可满足不同场景下的 AI Agent 应用需求。

## 主要功能

### 核心能力
- **多 Agent 运行时支持**：集成 Customer Agent、Codex、Claude Code 等多种 Agent 运行时，提供统一的接入层和会话管理
- **智能上下文管理**：支持上下文压缩、Token 估算、对话历史分页检索，提升长对话场景下的模型响应质量
- **工具系统**：内置文件操作、搜索、代码编辑、Web 抓取等工具，支持远程 MCP 工具扩展
- **会话持久化**：SQLite 持久化存储，支持会话历史恢复、跨会话上下文继承

### 交互能力
- **语音交互**：集成 ASR 语音识别、TTS 语音合成、唤醒词检测、打断处理（Barge-In）等能力
- **多端适配**：提供 Web 端、TUI 终端、Electron 桌面端三种交互入口，统一会话状态同步
- **目标队列**：支持会话目标（Goal）的排队、排序、状态跟踪，实现复杂任务的多轮迭代

### 运维能力
- **Agent 运行时托管**：自动化的运行时版本管理、健康检查、故障恢复
- **跨平台运行时**：提供 macOS/Windows 平台的本地 Agent 运行时包，支持 Node.js 22、Codex 等运行时托管
- **云隧道服务**：集成 Cloudflared/Pinggy 隧道，支持内网穿透和公网访问
- **本地服务常驻**：macOS LaunchAgent、Windows Task Scheduler 服务化支持

## 项目结构

```
team-agent/
├── packages/
│   ├── core/              # 核心引擎（Agent 循环、工具系统、上下文组装等）
│   ├── desktop/           # Electron 桌面端（主进程、渲染进程、语音模块）
│   ├── server/            # Next.js 服务端（API 路由、会话管理、Web 控制台）
│   ├── sdk/               # 嵌入式 SDK（Web Component 聊天组件）
│   ├── cli/               # CLI 工具（AgentRoam 隧道客户端）
│   ├── cloudflared-*/     # Cloudflared 平台产物包
│   └── runtime-*/         # 平台运行时包
├── deploy/
│   └── frp/               # FRP 内网穿透配置
├── docs/
│   ├── core-technology.md # 核心技术文档
│   └── superpowers/       # 特性设计文档（specs）和实施计划（plans）
├── outputs/
│   └── architecture-diagrams/  # 架构图
└── .workbuddy/            # 工作日志
```

### 核心模块说明

| 模块 | 职责 |
|------|------|
| `packages/core/src/domain/agent/` | Agent 循环、上下文压缩、Token 估算 |
| `packages/core/src/domain/tool/` | 工具系统（文件、搜索、Web 等内置工具） |
| `packages/core/src/domain/session/` | 会话存储、历史管理、目标队列 |
| `packages/core/src/domain/model/` | 模型抽象、多 Provider 支持 |
| `packages/desktop/main/` | Electron 主进程、语音服务、Native Runtime Broker |
| `packages/desktop/renderer/` | React 渲染层、ChatView、侧边栏 |
| `packages/server/app/api/` | Next.js API 路由（Agent 会话、模型、Web 控制台） |

## 快速开始

### 环境要求

- Node.js 22+
- Bun 1.0+
- SQLite 3.35+
- TypeScript 5.0+

### 安装依赖

```bash
# 安装所有依赖
bun install

# 安装平台产物包
bun run setup
```

### 本地开发

```bash
# 启动桌面端开发服务器
cd packages/desktop && bun dev

# 启动 Web 服务
cd packages/server && bun dev

# 启动 TUI 终端
cd packages/cli && bun run agent-tui
```

### 构建发布

```bash
# 构建所有包
bun run build

# 构建 CLI 并发布
cd packages/cli && npm publish
```

## 开发指南

### 代码规范

- TypeScript 严格模式
- 提交前运行 `bun run typecheck` 和 `bun run test`
- 遵循Conventional Commits 规范

### 文档链接

- [核心技术文档](docs/core-technology.md)
- [特性设计文档](docs/superpowers/specs/)
- [实施计划](docs/superpowers/plans/)
- [工作日志](.workbuddy/memory/)

### 常用命令

```bash
# 类型检查
bun run typecheck

# 运行测试
bun run test

# 代码格式化
bun run format

#  lint 检查
bun run lint

# 构建所有包
bun run build

# 清理构建产物
bun run clean
```

## 许可证

本项目采用 [LICENSE](LICENSE) 中声明的许可证开源。