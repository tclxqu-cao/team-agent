# Shared Agent Run Use Case Design

## Status

Approved architecture direction. Written specification pending final review before implementation.

## Goal

Replace the isolated Portfolio Skill Runner with the same persistent Customer Agent execution path used by the CA WebApp and desktop app. A caller may select a model profile, Agent, Skill, message, and optional conversation metadata. Every accepted run creates or continues a normal CA session, streams normal Agent events, and is visible from the desktop and WebApp session lists.

"Public" means a shared application contract available to trusted adapters and authenticated service clients. It does not mean that an anonymous browser may select arbitrary models, Skills, tools, or credentials.

## Current State

- The CA WebApp posts to `POST /api/agent/run`, subscribes to `/api/agent/stream`, and persists the run through the server `AgentHost` and `SQLiteSessionStore`.
- The desktop renderer calls `window.agentApi.run`, which reaches the desktop `AgentHost` over Electron IPC.
- The Portfolio endpoint builds a separate restricted `AgentBuilder`, runs with a generated `portfolio-*` ID, and does not create a normal Session. Those runs therefore do not appear in the desktop conversation list.
- Agent definitions already own the allowed tools, Skills, MCP servers, default model profile, and system prompt.

## Considered Approaches

### 1. Extend the existing run contract and share an application use case

Both HTTP and IPC map their inputs to one `StartAgentRunCommand`. The application use case validates the selected Agent, Skill, model profile, and Session, then delegates execution to the runtime port. Existing SSE and desktop event transports remain unchanged.

This is the selected approach. It preserves existing clients, removes the Portfolio-specific runtime, and creates one place for run policy without forcing Electron to make a loopback HTTP request.

### 2. Add a second `/api/agent-loop/runs` endpoint

This produces a cleaner new URL but duplicates the lifecycle already represented by `/api/agent/run`, requires two contracts to remain compatible, and encourages callers to bypass the existing WebApp path. It is rejected.

### 3. Make every client call the HTTP endpoint, including desktop

This maximizes transport reuse, but makes desktop execution depend on a loopback server and authentication path even when IPC is available. It also conflates transport reuse with application reuse. It is rejected; desktop IPC and Web HTTP remain separate adapters over the same use case.

## Domain Model

The shared contract belongs to the Customer Agent execution bounded context.

### Value objects

```ts
interface StartAgentRunCommand {
  message: string;
  sessionId?: string;
  agentId?: string;
  skillName?: string;
  modelProfileId?: string;
  images?: string[];
  session?: {
    projectId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  source: "desktop" | "webapp" | "sdk" | "portfolio" | "flow-studio";
}

interface StartedAgentRun {
  sessionId: string;
  runId: string;
  streamRef: string;
}
```

The application layer receives model profile identity, never a raw API key from an anonymous caller. Existing trusted SDK inline-model support remains a compatibility path controlled by the transport authorization policy and is not part of the new Portfolio contract.

### Invariants

1. A supplied Agent must exist and be enabled.
2. A supplied Skill must exist and be listed in the selected Agent's `enabledSkills`.
3. A supplied model profile must exist. If omitted, the Agent default and then the global default apply.
4. An existing Session remains authoritative for identity and history. A missing Session is created before the run is admitted.
5. One Session admits at most one active CA run.
6. The selected Skill is explicitly activated for the turn; it is not left to semantic matching.
7. Tools and MCP servers continue to come only from the Agent definition. Selecting a Skill cannot widen those capabilities.

## Application Layer

Add a `StartAgentRunUseCase` under `packages/core/src/application/agent-run`. It depends only on ports:

```ts
interface AgentRunCatalog {
  getAgent(id: string): Promise<AgentDefinition | null>;
  getSkill(name: string): Promise<SkillDefinition | null>;
  getModelProfile(id: string): Promise<ModelProfile | null>;
}

interface AgentRunSessionRepository extends ISessionStore {}

interface AgentRunRuntime {
  start(command: ValidatedAgentRun): StartedRunHandle;
}
```

The use case performs validation, resolves defaults, creates the Session when needed, records source metadata, and returns the admitted run identity. `AgentRunRuntime` owns AgentBuilder wiring, ReAct execution, event persistence, abort, and runtime resource cleanup.

Domain validation errors are typed and transport-independent. HTTP and IPC adapters translate them into their own response/error forms.

## Explicit Skill Activation

`skillName` has two effects:

1. Capability validation checks that the chosen Agent allows the Skill.
2. The builder receives the Skill as an explicitly activated Skill for this turn, so its prompt is loaded before the first model request.

This is separate from `enabledSkills`: enabled Skills form the allowlist, while the explicitly activated Skill is the one requested by the workflow branch. Natural-language runs may omit `skillName` and continue using trigger and semantic matching within the Agent allowlist.

The original user message is persisted unchanged. The implementation must not fake explicit selection by prepending a hidden slash command to the stored message.

## Adapters

### WebApp HTTP adapter

Extend `POST /api/agent/run` without breaking existing fields:

```json
{
  "input": "Show the projects related to knowledge systems",
  "sessionId": "optional-session-id",
  "agentId": "portfolio-content-agent",
  "skillName": "portfolio-works",
  "profileId": "aihub-deepseek",
  "projectId": "portfolio",
  "title": "Portfolio: works",
  "metadata": {
    "source": "flow-studio",
    "flowId": "homepage-main",
    "routeId": "works"
  }
}
```

`agentIds` remains supported for existing clients. New external callers use one `agentId`; accepting both in one request is invalid. The response and SSE contract remain compatible:

```json
{
  "sessionId": "...",
  "runId": "...",
  "streamUrl": "/api/agent/stream?sessionId=..."
}
```

The CA WebApp continues calling this route through `AgentHttpGateway`.

### Desktop IPC adapter

`window.agentApi.run` maps to the same `StartAgentRunUseCase` directly from Electron main. It does not make an HTTP request. Existing positional IPC arguments should be replaced internally by a command object while retaining a compatibility bridge for the current renderer during migration.

### SDK adapter

Extend `AgentClient.run` with an options object for Agent, Skill, profile, and Session metadata. Bearer authorization continues through the existing device/SDK gateway.

### Flow Studio and public homepage

Flow Studio calls the authenticated CA HTTP endpoint from its server-side gateway. The browser never receives the CA service token. Slash-command branches pass a fixed `agentId`, `skillName`, and profile configured on the flow node. Natural-language branches first resolve intent, then pass the chosen fixed Skill. The resulting Session metadata records the flow and route for desktop filtering and audit.

## Runtime Data Flow

```text
CA WebApp HTTP ----\
Flow Studio HTTP ---+--> StartAgentRunUseCase --> AgentRunRuntime --> AgentLoop
SDK HTTP -----------/             |                    |              |
Desktop IPC ----------------------/                    |              +--> tools / skills / MCP
                                  |                    +-----------------> persisted events
                                  +--> SessionStore ----------------------> desktop and WebApp history
```

All consumers observe the same persistent Session contract. Transport-specific streaming remains outside the domain: WebApp/SDK use SSE and desktop uses IPC events.

## Authentication And Capability Boundary

- `/api/agent/run` remains behind the existing device/SDK authentication gateway.
- Flow Studio uses a server-held service token; a public browser cannot read it.
- The HTTP adapter accepts IDs, not arbitrary Skill prompts or Agent definitions.
- `skillName` must be allowed by the selected Agent.
- `profileId` resolves a stored profile. Secret values are never returned to callers or written into Session metadata.
- Existing Agent tool and MCP allowlists remain authoritative.
- Request message, metadata, image count/size, and identifier lengths are bounded before admission.

## Error Contract

- `400 INVALID_RUN_REQUEST`: malformed or mutually exclusive fields.
- `401 UNAUTHORIZED`: missing or invalid device/SDK/service authorization.
- `404 AGENT_NOT_FOUND`, `SKILL_NOT_FOUND`, or `MODEL_PROFILE_NOT_FOUND`.
- `409 SESSION_ALREADY_RUNNING`: the Session already owns a live run.
- `422 SKILL_NOT_ALLOWED`: the Skill exists but is not enabled for the selected Agent.
- `503 MODEL_PROFILE_UNAVAILABLE`: the stored profile cannot currently create a provider.

No validation failure creates a Session. A failure after admission persists an error event and marks the Session failed.

## Migration

1. Introduce the shared command, typed errors, ports, and `StartAgentRunUseCase` with unit tests.
2. Adapt the server `AgentHost` and `/api/agent/run` to the use case while retaining the current request and SSE fields.
3. Adapt desktop IPC to the same use case and command shape.
4. Extend the SDK and WebApp gateway options.
5. Change Flow Studio to call `/api/agent/run` and consume `/api/agent/stream`.
6. Preserve Portfolio artifact parsing at the Flow Studio boundary; it converts normal Agent output/events into text, image, video, or HTML presentation artifacts.
7. Delete `/api/portfolio/skills/run` and `portfolio-skill-runner` only after the Flow Studio path passes runtime acceptance.

There is no dual execution fallback after migration. Static Portfolio data remains a presentation fallback only when the configured CA endpoint is unreachable; it must not start the isolated runner.

## Verification

Automated tests must cover:

- command validation and typed error mapping;
- Session creation, continuation, source metadata, and conflict handling;
- Agent, Skill, and model profile resolution precedence;
- explicit Skill activation without changing the persisted user message;
- rejection of a Skill outside the Agent allowlist;
- preservation of tool and MCP capability boundaries;
- HTTP backward compatibility for `input`, `agentIds`, SSE, and existing WebApp calls;
- desktop IPC compatibility and mapping to the shared command;
- SDK authorization and options serialization;
- removal of the isolated Portfolio runtime path.

Runtime acceptance must prove:

1. A Flow Studio request reaches the real CA AgentLoop and streams Agent events.
2. Its Session immediately appears in both CA desktop and WebApp history with source metadata.
3. The selected AIHub profile and explicit Portfolio Skill are used.
4. A natural-language run without `skillName` still performs intent-based Skill matching.
5. An unbound Skill and an unauthenticated request are rejected before the model runs.
6. Restarting CA preserves the Session and its final response.

## Non-goals

- Anonymous direct access to arbitrary CA Agents, models, tools, MCP servers, or Skills.
- A second Portfolio-only AgentLoop implementation.
- Moving artifact rendering into the Agent domain.
- Replacing SSE with a new streaming protocol.
- Forcing desktop IPC through loopback HTTP.
