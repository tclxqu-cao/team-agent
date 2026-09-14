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

## npm Publishing Policy

- Publish npm packages with an npm access token supplied at release time. Do not use the browser WebAuthn publishing flow.
- Never store or commit the token. Put it in a permission-restricted temporary npm user config, clear that file when publishing exits, and leave the global `.npmrc` unchanged.
- Always publish against `https://registry.npmjs.org` with public access. Local token-based publishes must pass `--provenance=false`; the dist-tag must match the release target (`preview` for prereleases).
- Publish platform dependency packages before the `agentroam` launcher, then verify dist-tags and exact versions from the official registry.

## Incremental CLI Releases

- Default to incremental npm releases: `npm run plan:cli -- --base <last-published-source-commit> --version <new-version>`, then `npm run pack:cli -- --base <same-commit> --version <same-version>` in an isolated release checkout.
- Review the plan's per-package reasons. Shared inputs conservatively rebuild dependent packages. Unchanged packages retain the baseline launcher's exact dependency versions and are downloaded from the official registry; an unavailable reused version blocks the release rather than falling back silently.
- Run tarball audits and fresh-install verification, then use `publish-agentroam-release.mjs publish-preview` with the generated release manifest. Only changed packages are uploaded, platform dependencies before the launcher. Reused package tags are left untouched.
- Do not bump all platform package versions merely to match the launcher. `pack:cli:all` remains an explicit full-build path, not the default release command.
