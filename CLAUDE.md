# Customer Agent

A general-purpose AI agent supporting tool calling, MCP, skills, plugins, model adaptation, and ReAct loop.

## Project Structure

```
packages/
├── core/        # Framework-agnostic domain logic (DDD)
├── server/      # Next.js API server
└── desktop/     # Electron + React desktop app
```

## Core Architecture (8 Domains)

| Domain    | Responsibility                        |
|-----------|---------------------------------------|
| agent     | ReAct loop, AgentBuilder, events      |
| model     | LLM provider abstraction (Anthropic/OpenAI/DeepSeek) |
| tool      | Tool definitions, registry, executor  |
| mcp       | MCP client, stdio transport           |
| skill     | SKILL.md loading, trigger matching    |
| plugin    | Plugin lifecycle, PluginAPI           |
| context   | Project file loading, prompt assembly |
| memory    | Filesystem memory in `memory/` folder |
| session   | Session management                    |

## Key Patterns

- All domains depend on interfaces, not implementations
- AgentBuilder is the main entry point for wiring
- AgentLoop follows ReAct: observe → think → act → observe
- Model providers all implement `IModelProvider` with streaming

## Getting Started

```bash
bun install
bun run dev:server   # Next.js API on port 3000
bun run dev:desktop  # Electron + React
bun test             # Run tests
```

## Git Push Policy

- This project uses standard Git for commits and pushes. Do not run `git-ai`, create AI attribution checkpoints, or sync `refs/notes/ai`.
