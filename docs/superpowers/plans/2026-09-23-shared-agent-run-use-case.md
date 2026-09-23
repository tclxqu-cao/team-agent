# Shared Agent Run Use Case Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the isolated Portfolio Skill Runner with the authenticated, persistent CA AgentLoop run contract shared by WebApp, desktop, SDK, and Flow Studio.

**Architecture:** Add a transport-independent `StartAgentRunUseCase` in `@agent/core`, with catalog, session, and runtime ports. The server HTTP route and existing shared-service desktop/WebApp clients use this application service; Flow Studio calls the same HTTP/SSE contract with an Agent, explicit Skill, model profile, and bounded context.

**Tech Stack:** TypeScript, Bun/Vitest, Next.js route handlers, Electron shared-service adapter, Python 3.11, httpx, pytest.

## Global Constraints

- Preserve all unrelated dirty-worktree changes in both repositories.
- The persisted user message must remain unchanged.
- Explicit Skill selection may only narrow the selected Agent's `enabledSkills` allowlist.
- Model selection uses a stored `profileId`; Portfolio callers never send raw API keys.
- Flow Studio keeps its validated last-success static artifact fallback.
- The desktop and WebApp continue sharing the same service, SessionStore, and SSE run stream.

---

### Task 1: Explicit Skill Activation In The Agent Domain

**Files:**
- Modify: `packages/core/src/domain/agent/entities.ts`
- Modify: `packages/core/src/domain/agent/AgentBuilder.ts`
- Modify: `packages/core/src/domain/agent/AgentLoop.ts`
- Modify: `packages/core/src/domain/agent/AgentBuilder.test.ts`
- Unit tests: `packages/core/src/domain/agent/__tests__/AgentLoop.test.ts`

**Interfaces:**
- Consumes: existing `ISkillRegistry.load(name, enabledSkills)` and `AgentConfig.enabledSkills`.
- Produces: `AgentConfig.activatedSkills?: string[]` and `AgentBuilder.withActivatedSkills(skillNames: string[]): this`.

- [x] **Step 1: Add explicit activation to the Agent configuration**

```ts
interface AgentConfig {
  enabledSkills?: string[] | null;
  activatedSkills?: string[];
}
```

- [x] **Step 2: Add builder state and copy it into every AgentConfig**

```ts
withActivatedSkills(skillNames: string[]): this {
  this.activatedSkills = [...new Set(skillNames.filter(Boolean))];
  return this;
}
```

- [x] **Step 3: Load explicit Skill prompts before context assembly**

```ts
const skillPrompts = await loadActivatedSkillPrompts(
  this.config.skillRegistry,
  this.config.activatedSkills,
  this.config.enabledSkills,
);
```

Pass `skillPrompts` to `ContextAssembler` without changing `input` or persisted messages.

- [x] **Step 4: Add focused tests**

Verify that an activated allowed Skill is present in the first model request, a non-activated Skill is absent, and the user message is byte-for-byte unchanged.

### Task 2: DDD StartAgentRun Application Service

**Files:**
- Create: `packages/core/src/application/agent-run/StartAgentRunUseCase.ts`
- Create: `packages/core/src/application/agent-run/StartAgentRunUseCase.test.ts`
- Create: `packages/core/src/application/agent-run/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ISessionStore`, `AgentDefinition`, `SkillDefinition`, and stored model profile identities.
- Produces: `StartAgentRunCommand`, `ValidatedAgentRun`, `StartedAgentRun`, `AgentRunError`, `AgentRunCatalog`, `AgentRunRuntime`, and `StartAgentRunUseCase.execute()`.

- [x] **Step 1: Define the application command and ports**

```ts
export interface StartAgentRunCommand {
  message: string;
  sessionId?: string;
  agentId?: string;
  skillName?: string;
  modelProfileId?: string;
  images?: string[];
  context?: Record<string, unknown>;
  session?: { projectId?: string; title?: string; metadata?: Record<string, unknown> };
  source: "desktop" | "webapp" | "sdk" | "portfolio" | "flow-studio";
}
```

- [x] **Step 2: Validate Agent, Skill, profile, and request bounds**

Reject an unknown Agent, a Skill without `agentId`, a missing Skill, a Skill not explicitly present in `enabledSkills`, an unknown profile, oversized input/context, and mutually invalid values with typed error codes.

- [x] **Step 3: Create or reuse the persistent Session and start the runtime**

Create the Session only after all validation succeeds. Merge bounded source metadata without overwriting unrelated existing metadata, then call `runtime.start(validated)`.

- [x] **Step 4: Add unit tests for invariants**

Cover validation-before-session-creation, explicit Skill allowlisting, profile resolution, Session creation metadata, Session reuse, and runtime result forwarding.

### Task 3: Customer Agent Server Adapter And Portfolio Capability

**Files:**
- Create: `packages/server/lib/portfolio-content-agent.ts`
- Modify: `packages/server/lib/shared-run-config.ts`
- Modify: `packages/server/app/api/agent-host.ts`
- Modify: `packages/server/app/api/agent/run/route.ts`
- Modify: `packages/server/app/api/agent-host.test.ts`
- Move focused tests from: `packages/server/lib/portfolio-skill-runner.test.ts`

**Interfaces:**
- Consumes: `StartAgentRunUseCase`, `businessCatalog()`, `sharedSettings()`, and `agentHost.startRun()`.
- Produces: the extended compatible `POST /api/agent/run` body with `agentId`, `skillName`, `projectId`, `title`, `metadata`, and `context`.

- [x] **Step 1: Extract the public Wiki tool and Portfolio catalog bootstrap**

Create `ensurePortfolioContentAgent()` that seeds the Portfolio Skills and `portfolio-content-agent` definition only when absent. Keep `PublicWikiQueryTool` path containment, file-size, result-count, and public-root restrictions.

- [x] **Step 2: Support explicit Skill and bounded run context in shared run configuration**

```ts
interface SharedRunOptions {
  activatedSkills?: string[];
  context?: Record<string, unknown>;
}
```

Apply `.withActivatedSkills()` and add `PublicWikiQueryTool` before `build()` only when selected by the Portfolio Agent capability.

- [x] **Step 3: Route HTTP admission through StartAgentRunUseCase**

Map existing `input`, `agentIds`, and profile fields compatibly. Reject simultaneous `agentId` and `agentIds`. Convert typed application errors to `400/404/409/422/503` while leaving native-runtime admission unchanged.

- [x] **Step 4: Prove persisted, visible Portfolio runs**

Test that a request creates a normal Session with `source=flow-studio`, calls `agentHost.startRun` with the Agent/profile/activated Skill, and returns the existing `sessionId/runId/streamUrl` response.

### Task 4: Shared WebApp And SDK Contract

**Files:**
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`
- Modify: `packages/sdk/src/client/AgentClient.ts`
- Modify: `packages/sdk/src/client/types.ts`

**Interfaces:**
- Consumes: extended `POST /api/agent/run` contract.
- Produces: optional `AgentRunOptions` with `agentId`, `skillName`, `profileId`, `projectId`, `title`, `metadata`, and `context`.

- [x] **Step 1: Extend SDK run options without breaking the two-argument call**

```ts
run(input: string, sessionId: string, options?: AgentRunOptions): Promise<void>
```

- [x] **Step 2: Keep WebApp and desktop shared-service behavior compatible**

Retain the existing gateway request for ordinary runs and add only optional fields when supplied. The Electron `SharedServiceRoot` continues using this gateway, so no legacy desktop AgentHost path is introduced.

- [x] **Step 3: Add serialization tests**

Verify old requests remain unchanged and new options serialize exact IDs and bounded metadata without credentials.

### Task 5: Flow Studio Migration

**Files:**
- Modify: `/Users/caoqu/agent-free/src/flow_studio/bridge.py`
- Modify: `/Users/caoqu/agent-free/src/flow_studio/agentrt.py`
- Modify: `/Users/caoqu/agent-free/tests/test_flow_bridge.py`
- Modify: `/Users/caoqu/agent-free/tests/test_homepage_flow.py`

**Interfaces:**
- Consumes: authenticated `POST /api/agent/run` plus `GET /api/agent/stream`.
- Produces: `portfolio_skill()` implemented as a thin adapter over the common persistent run protocol.

- [x] **Step 1: Generalize `agent_reason` request options**

```py
def agent_reason(cfg, prompt, session_id=None, *, agent_id=None,
                 skill_name=None, profile_id=None, project_id=None,
                 title=None, metadata=None, context=None, timeout=300.0): ...
```

Forward the configured service token and use it for both POST and SSE requests.

- [x] **Step 2: Replace the Portfolio-only streaming endpoint**

Call `agent_reason()` with `agent_id="portfolio-content-agent"`, parse `done.finalText` as JSON, validate it through `validate_artifact`, and return the real CA `session_id` and `run_id`.

- [x] **Step 3: Preserve CA Session identity through AgentRuntime**

Return the external CA Session ID instead of overwriting it with the local Flow run ID. Record the local Flow run ID separately in request metadata.

- [x] **Step 4: Update fake-server and homepage tests**

Assert `/api/agent/run` receives the fixed Agent, exact Skill, model profile, source metadata, and context; assert SSE returns a final artifact and its real Session ID.

### Task 6: Remove The Isolated Runner

**Files:**
- Delete: `packages/server/app/api/portfolio/skills/run/route.ts`
- Delete: `packages/server/lib/portfolio-skill-runner.ts`
- Delete: `packages/server/lib/portfolio-skill-runner.test.ts`
- Modify: `packages/server/lib/portfolio-skill-defaults.ts` if imports move

**Interfaces:**
- Consumes: completed shared server and Flow Studio migration.
- Produces: no remaining production call path that creates `portfolio-<uuid>` transient AgentLoop sessions.

- [x] **Step 1: Remove the route and isolated builder**

Delete only after all callers and reusable public-Wiki functionality have moved.

- [x] **Step 2: Scan for obsolete endpoint references**

Run `rg "api/portfolio/skills/run|buildRestrictedPortfolioAgent|runPortfolioSkill"` and require zero production matches.

- [x] **Step 3: Confirm static artifacts remain presentation fallback only**

Keep `HomepageArtifactStore` behavior unchanged; it is used only when the common CA endpoint is unreachable or fails.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
cd /Users/caoqu/team-agent/customer-agent
bunx vitest run \
  packages/core/src/application/agent-run/StartAgentRunUseCase.test.ts \
  packages/core/src/domain/agent/AgentBuilder.test.ts \
  packages/core/src/domain/agent/__tests__/AgentLoop.test.ts \
  packages/server/app/api/agent-host.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts
bun run --cwd packages/core build
bun run --cwd packages/server build

cd /Users/caoqu/agent-free
uv run pytest tests/test_flow_bridge.py tests/test_homepage_flow.py -q
```

Expected: all focused tests pass and both TypeScript packages build. If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
