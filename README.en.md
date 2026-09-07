# Team Agent - Multimodal Intelligent Agent Runtime Platform

## Project Introduction

Team Agent is an enterprise-grade multimodal intelligent Agent runtime platform. It supports multiple Agent runtimes (Customer Agent, Codex, Claude Code, etc.), providing unified session management, local/remote runtime support, voice interaction, and terminal/Web/desktop multi-end adaptation capabilities. The platform adopts a modular architecture design, supports cross-platform deployment, and can meet AI Agent application needs in various scenarios.

## Main Features

### Core Capabilities
- **Multi-Agent Runtime Support**: Integrates various Agent runtimes such as Customer Agent, Codex, and Claude Code, providing a unified access layer and session management.
- **Smart Context Management**: Supports context compression, token estimation, and pagination retrieval of conversation history to improve model response quality in long conversation scenarios.
- **Tool System**: Built-in tools for file operations, search, code editing, web scraping, etc., supporting remote MCP tool extensions.
- **Session Persistence**: SQLite persistent storage, supporting session history recovery and cross-session context inheritance.

### Interaction Capabilities
- **Voice Interaction**: Integrates capabilities such as ASR speech recognition, TTS speech synthesis, wake word detection, and barge-in handling.
- **Multi-End Adaptation**: Provides three interaction entry points: Web, TUI Terminal, and Electron Desktop, with unified session state synchronization.
- **Goal Queue**: Supports queuing, sorting, and status tracking of session goals, enabling multi-round iteration for complex tasks.

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