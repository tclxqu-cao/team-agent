# OpenCode Runtime Integration Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode as a first-class AgentRoam runtime across Web and Desktop with native history, streaming, permissions, attachments, fork, abort, broker recovery, and managed executable fallback.

**Architecture:** Treat OpenCode as an agent runtime, not an LLM provider. An infrastructure adapter translates the official OpenCode SDK and its managed headless server into the existing `AgentRuntimeAdapter`; `UnifiedSessionService` and `NativeRuntimeBroker` remain the application/domain coordination boundary, while HTTP, Electron, renderer, and SDK surfaces consume only the shared runtime contract.

**Tech Stack:** TypeScript, `@opencode-ai/sdk@1.18.27`, Node child processes, SSE, SQLite-backed native broker, React, Vitest.

## Global Constraints

- Support `customer-agent`, `codex`, `claude-code`, and `opencode` without runtime-specific branches in shared application services.
- Resolve OpenCode from `AGENT_OPENCODE_BIN`, then compatible `PATH`, then an AgentRoam-managed `opencode-ai@1.18.27` installation.
- Keep OpenCode credentials and project configuration in OpenCode; AgentRoam must not copy provider secrets or maintain a second model configuration.
- Map OpenCode protocol data into existing `UnifiedSessionSummary`, `Message`, `AgentEvent`, `RuntimeQuestionAnswer`, and `ToolPermissionMode` contracts.
- Preserve user work already present in the dirty worktree and do not modify generated `.next` output.

---

### Task 1: OpenCode Protocol Client And Runtime Adapter

**Files:**
- Create: `packages/desktop/main/agent-runtime/opencode-server-client.ts`
- Create: `packages/desktop/main/agent-runtime/opencode-runtime-adapter.ts`
- Create: `packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts`
- Modify: `packages/desktop/package.json`
- Modify: `packages/server/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `AgentRuntimeAdapter`, OpenCode `Session`, `Message`, `Part`, `Event`, and the Core permission classifier.
- Produces: `OpenCodeRuntimeAdapter implements AgentRuntimeAdapter` and `OpenCodeServerClient` with lazy process startup, typed client access, event subscription, and disposal.

- [ ] **Step 1: Add the pinned official SDK**

Add `@opencode-ai/sdk: "1.18.27"` to the processes that compile/import native runtime code and update the lockfile.

- [ ] **Step 2: Implement the managed server client**

Implement a lazy localhost server wrapper that starts the resolved executable as `opencode serve`, waits for `/global/health`, creates an official SDK client, shares one SSE subscription, rejects pending work on exit, and closes only its own child process.

- [ ] **Step 3: Implement native-to-domain mapping**

Map OpenCode session timestamps/status, user and assistant messages, text/reasoning/file/tool parts, errors, and parent sessions into the existing domain types. Ignore unsupported part/event kinds instead of coercing them into chat text.

- [ ] **Step 4: Implement run, permission, attachment, fork, and abort behavior**

Use `prompt_async` plus session-scoped SSE events, encode Web image data URLs as OpenCode file parts, turn permission events into `ask_user`, answer with `once`/`always`/`reject`, terminate on idle/error/abort, and use OpenCode's native fork and abort APIs.

- [ ] **Step 5: Cover protocol behavior with focused tests**

Test discovery, history conversion, streaming deltas without duplication, tool completion, image input/history, permission mode decisions, fork, abort, malformed events, process failure, and independent concurrent sessions.

### Task 2: Domain Registration And Broker Recovery

**Files:**
- Modify: `packages/desktop/main/agent-runtime/types.ts`
- Modify: `packages/desktop/main/agent-runtime/session-id.ts`
- Modify: `packages/desktop/main/agent-runtime/index.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.test.ts`
- Modify: `packages/desktop/main/agent-runtime/session-id.test.ts`
- Modify: `packages/desktop/main/agent-runtime/unified-session-service.test.ts`

**Interfaces:**
- Consumes: `OpenCodeRuntimeAdapter` and existing broker run/event/approval persistence.
- Produces: `AgentType` includes `opencode`; broker accepts and hosts it like every other native runtime.

- [ ] **Step 1: Extend the closed runtime identity set**

Add `opencode` to encoded session validation and all compile-time native runtime unions.

- [ ] **Step 2: Register the adapter in the broker host**

Construct one OpenCode server client and adapter beside Codex and Claude, pass `AGENT_OPENCODE_BIN`, and dispose it with the shared runtime.

- [ ] **Step 3: Preserve broker recovery semantics**

Verify OpenCode runs use the existing synchronous admission, event sequence persistence, approval replay, per-session termination, Web/Desktop controller handoff, goal state, and pending-creation projection.

- [ ] **Step 4: Add broker and unified service regression cases**

Assert OpenCode create/list/get/run/fork/abort/answer routing, encoded IDs, isolation after runtime failure, and goal/permission state projection.

### Task 3: Executable Resolution And Managed Fallback

**Files:**
- Create: `packages/cli/src/opencode-runtime-manager.ts`
- Create: `packages/cli/src/opencode-runtime-manager.test.ts`
- Modify: `packages/cli/src/runtime-manager.ts`
- Modify: `packages/cli/src/runtime-manager.test.ts`
- Modify: `packages/server/lib/native-runtime-service.ts`

**Interfaces:**
- Consumes: launcher data directory, platform target, npm executor, and process environment.
- Produces: `OpenCodeRuntimeResolution { executable, version, source }` and child environment keys `AGENT_OPENCODE_BIN` / `AGENT_OPENCODE_RUNTIME_ERROR`.

- [ ] **Step 1: Resolve explicit and PATH installations**

Require an absolute explicit override, parse `opencode --version`, require version `1.18.27`, and skip incompatible PATH candidates without changing the user's installation.

- [ ] **Step 2: Install and validate the managed fallback**

Install `opencode-ai@1.18.27` from the official npm registry under the AgentRoam data directory with an atomic activation directory and concurrent install lock, then validate `serve --help`.

- [ ] **Step 3: Inject launcher and service diagnostics**

Resolve Codex and OpenCode independently so either runtime can fail without preventing AgentRoam startup; make runtime health surface the managed-resolution failure when no executable is available.

- [ ] **Step 4: Add resolver tests**

Cover source precedence, invalid overrides, incompatible global versions, managed reuse/install, concurrent install locking, cleanup, and environment error propagation.

### Task 4: Web, Desktop, Renderer, And SDK Parity

**Files:**
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/components/RuntimeSessionMenu.tsx`
- Modify: `packages/desktop/renderer/lib/runtime-capabilities.ts`
- Modify: `packages/desktop/renderer/lib/occupied-session-fork.ts`
- Modify: `packages/desktop/renderer/lib/native-session-view-state.ts`
- Modify: `packages/desktop/renderer/lib/session-history.ts`
- Modify: `packages/desktop/renderer/styles/global.css`
- Modify: `packages/server/app/api/sessions/route.ts`
- Modify: `packages/sdk/src/client/types.ts`
- Modify: `packages/sdk/src/components/AgentChat.ts`

**Interfaces:**
- Consumes: shared `AgentType`, `RuntimeHealth`, `UnifiedSessionSummary`, and current renderer gateway contract.
- Produces: OpenCode runtime selection, `OC` identity, grouping, capability decisions, and public SDK typing.

- [ ] **Step 1: Register OpenCode at API and Electron composition roots**

Pass the resolved executable into the broker factory and accept `opencode` in session creation validation without adding route-owned runtime state.

- [ ] **Step 2: Add renderer identity and capabilities**

Add the `OC` mark and `OpenCode` label, include it in stable group ordering and menu health states, enable occupied-session fork, and keep mid-turn steering disabled so queued input runs after idle.

- [ ] **Step 3: Extend public types and lightweight SDK UI**

Add `opencode` to SDK client types and bot grouping without changing existing runtime identifiers or response shapes.

- [ ] **Step 4: Add focused contract tests**

Update union-driven tests and add assertions for runtime menu, grouping, native read-only behavior, fork capability, session creation, and SDK rendering.

### Task 5: End-To-End Verification And Diff Audit

**Files:**
- Verify only; repair files from Tasks 1-4 when failures identify defects.

**Interfaces:**
- Consumes: the completed OpenCode runtime integration.
- Produces: evidence that the integration compiles, passes focused tests, and works against local OpenCode `1.18.27` without changing an existing session.

- [ ] **Step 1: Run focused runtime and UI tests**

Run the new adapter/resolver tests plus existing broker, unified-session, session-id, runtime capability, session route, and SDK component tests.

- [ ] **Step 2: Run package type checks**

Run Desktop, Server, WebApp, CLI, and SDK TypeScript checks using their repository scripts/configurations.

- [ ] **Step 3: Perform a non-destructive local smoke test**

Start the managed OpenCode server, verify health and read-only discovery of the existing local session, then stop only the child server created by the smoke test.

- [ ] **Step 4: Audit the final diff**

Confirm generated `.next` files and unrelated dirty-worktree changes are absent from this implementation's diff, and verify every OpenCode protocol type remains inside the infrastructure adapter.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/desktop/main/agent-runtime/opencode-runtime-adapter.test.ts packages/desktop/main/agent-runtime/native-runtime-broker.test.ts packages/desktop/main/agent-runtime/unified-session-service.test.ts packages/desktop/main/agent-runtime/session-id.test.ts packages/cli/src/opencode-runtime-manager.test.ts packages/cli/src/runtime-manager.test.ts packages/desktop/renderer/lib/runtime-capabilities.test.ts packages/server/app/api/agent-host.test.ts packages/sdk/src/components/AgentChat.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
