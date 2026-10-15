# Team Agent - Multimodal Intelligent Agent Runtime Platform

## Project Introduction

Team Agent is an enterprise-grade multimodal intelligent Agent runtime platform. It supports Customer Agent, Codex, Claude Code, OpenCode, and DeepSeek Harness, providing unified session management, local/remote runtime support, voice interaction, and terminal/Web/desktop multi-end adaptation capabilities. The platform adopts a modular architecture design, supports cross-platform deployment, and can meet AI Agent application needs in various scenarios.

## Main Features

### Core Capabilities
- **Multi-Agent Runtime Support**: Integrates Customer Agent, Codex, Claude Code, OpenCode, and DeepSeek Harness, providing a unified access layer and session management.
- **Smart Context Management**: Supports context compression, token estimation, and pagination retrieval of conversation history to improve model response quality in long conversation scenarios.
- **Tool System**: Built-in tools for file operations, search, code editing, web scraping, etc., supporting remote MCP tool extensions.
- **Session Persistence**: SQLite persistent storage, supporting session history recovery and cross-session context inheritance.

### Interaction Capabilities
- **Voice Interaction**: Integrates capabilities such as ASR speech recognition, TTS speech synthesis, wake word detection, and barge-in handling.
- **Multi-End Adaptation**: Provides three interaction entry points: Web, TUI Terminal, and Electron Desktop, with unified session state synchronization.
- **Goal Queue**: Supports queuing, sorting, and status tracking of session goals, enabling multi-round iteration for complex tasks.

### Agent Group Chat

Create a group for a project with one coordinator and multiple members. Send a goal to the group, and the coordinator breaks it into tasks, assigns members, manages dependencies and parallel work, and organizes delivery. Mix Customer Agent, Codex, Claude Code, OpenCode, and DeepSeek Harness, or add the same Agent type more than once with different models and roles, such as implementation, review, and testing.

- **Member configuration**: Choose each member's Agent, model, name, and role. Leave roles blank for the coordinator to assign.
- **Visible progress**: View member replies, task status, and results, including queue reasons when tasks wait for dependencies or an available working directory.
- **Task controls**: Add requirements during execution, answer Agent questions, stop a discussion, or use **继续协作** (Continue collaboration) to resume it.
- **Saved discussions**: Start separate discussions within a group and reopen their history below the member list. Group settings, messages, and task records are stored in the local database and remain available after closing a tab or refreshing.
- **File links and long messages**: Click file paths to view deliverables, and expand or collapse long messages.
- **Group dashboard**: Search by group name, member, or working directory; open, edit, or delete groups. Stop active discussions before changing group settings or deleting a group. Group setting changes apply to new discussions while existing discussion records are retained.

To get started:

1. In the Web console, open the avatar menu → **配置顶部工具** (Configure top tools), enable **群聊看板** (Group chat dashboard), then click its toolbar icon. On desktop, open **群聊看板** from the left sidebar.
2. Click **新增群聊** (Add group), choose a working directory, configure the coordinator and members, and set the maximum parallel tasks if needed. Selected Agents must be configured and available.
3. Send a goal in the group and follow execution and results. Reopen the group from the dashboard or the sidebar group list to continue later.

### Operations Capabilities
- **Agent Runtime Hosting**: Automated runtime version management, health checks, and fault recovery.
- **Cross-Platform Runtime**: Provides local Agent runtime packages for macOS/Windows platforms, supporting runtime hosting for Node.js 22, Codex, etc.
- **Cloud Tunnel Service**: Integrates Cloudflared/Pinggy tunnels, supporting intranet penetration and public network access.
- **Local Service Persistence**: macOS LaunchAgent, Windows Task Scheduler service-based support.

## Project Structure

```
team-agent/
├── packages/
│   ├── core/              # Core Engine (Agent Loop, Tool System, Context Assembly, etc.)
│   ├── desktop/           # Electron Desktop (Main Process, Renderer Process, Voice Module)
│   ├── server/            # Next.js Server (API Routes, Session Management, Web Console)
│   ├── sdk/               # Embedded SDK (Web Component Chat Component)
│   ├── cli/               # CLI Tools (AgentRoam Tunnel Client)
│   ├── cloudflared-*/     # Cloudflared Platform Artifacts
│   └── runtime-*/         # Platform Runtime Packages
├── deploy/
│   └── frp/               # FRP Intranet Penetration Configuration
├── docs/
│   ├── core-technology.md # Core Technology Documentation
│   └── superpowers/       # Feature Design Documents (specs) and Implementation Plans (plans)
├── outputs/
│   └── architecture-diagrams/  # Architecture Diagrams
└── .workbuddy/            # Work Logs
```

### Core Module Description

| Module | Responsibility |
|------|------|
| `packages/core/src/domain/agent/` | Agent Loop, Context Compression, Token Estimation |
| `packages/core/src/domain/tool/` | Tool System (Built-in tools like File, Search, Web, etc.) |
| `packages/core/src/domain/session/` | Session Storage, History Management, Goal Queue |
| `packages/core/src/domain/model/` | Model Abstraction, Multi-Provider Support |
| `packages/desktop/main/` | Electron Main Process, Voice Service, Native Runtime Broker |
| `packages/desktop/renderer/` | React Rendering Layer, ChatView, Sidebar |
| `packages/server/app/api/` | Next.js API Routes (Agent Session, Model, Web Console) |

## Quick Start

### Environment Requirements

- Node.js 22+
- Bun 1.0+
- SQLite 3.35+
- TypeScript 5.0+

### Install Dependencies

```bash
# Install all dependencies
bun install

# Install platform artifact packages
bun run setup
```

### Local Development

```bash
# Start Desktop Development Server
cd packages/desktop && bun dev

# Start Web Service
cd packages/server && bun dev

# Start TUI Terminal
cd packages/cli && bun run agent-tui
```

### Build & Release

```bash
# Build all packages
bun run build

# Build CLI and Publish
cd packages/cli && npm publish
```

## Development Guide

### Code Standards

- TypeScript Strict Mode
- Run `bun run typecheck` and `bun run test` before committing
- Follow Conventional Commits standards

### Documentation Links

- [Core Technology Documentation](docs/core-technology.md)
- [Feature Design Documents](docs/superpowers/specs/)
- [Implementation Plans](docs/superpowers/plans/)
- [Work Logs](.workbuddy/memory/)

### Common Commands

```bash
# Type Checking
bun run typecheck

# Run Tests
bun run test

# Code Formatting
bun run format

# Lint Check
bun run lint

# Build All Packages
bun run build

# Clean Build Artifacts
bun run clean
```

## License

This project is open-sourced under the license declared in [LICENSE](LICENSE).
