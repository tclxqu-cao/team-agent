# Generic Tool Execution Policy Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable Customer Agent tool execution policies that Flow Studio can select by ID, with generic filesystem, command, network, and resource enforcement before any tool implementation runs.

**Architecture:** `@agent/core` owns the policy domain, validation, SQLite persistence, and a policy-aware executor that wraps the existing permission-aware executor. `StartAgentRunUseCase` resolves an optional stored policy before creating a session and passes the immutable policy into the shared run adapter. Customer Agent exposes generic policy CRUD and catalog summaries; Flow Studio stores and forwards only `toolPolicyId`.

**Tech Stack:** TypeScript, Bun/Vitest, better-sqlite3, Next.js route handlers, React, Python 3, pytest, vanilla Flow Studio JavaScript.

## Global Constraints

- Do not branch on a Flow ID, Agent ID, Skill name, homepage, Wiki, QMD, GraphRAG, prompt, or input text.
- A caller may select only an existing stored policy ID and cannot inline or widen a policy.
- Effective authority is Agent tools intersected with run tools, policy tools, and Customer Agent global safety limits.
- Policy denial runs before interactive approval and cannot be overridden by approval.
- Restricted commands use `spawn(executable, args, { shell: false })`; shell syntax, nested shells, assignments, pipes, redirects, substitutions, control operators, and background execution are rejected.
- Filesystem access uses canonical paths and configured roots; traversal and symlink escapes are rejected.
- An absent `toolPolicyId` preserves existing run behavior.
- Preserve unrelated dirty work in both repositories.

---

### Task 1: Policy Domain And Persistence

**Files:**
- Create: `packages/core/src/domain/tool/execution-policy.ts`
- Create: `packages/core/src/domain/tool/execution-policy.test.ts`
- Create: `packages/core/src/infrastructure/SQLiteToolExecutionPolicyStore.ts`
- Create: `packages/core/src/infrastructure/SQLiteToolExecutionPolicyStore.test.ts`
- Modify: `packages/core/src/infrastructure/SQLiteDatabase.ts`
- Modify: `packages/core/src/domain/tool/index.ts`
- Modify: `packages/core/src/infrastructure/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ToolExecutionPolicy`, `ToolExecutionPolicySummary`, `ToolExecutionPolicyStore`, `validateToolExecutionPolicy(value)`, and `SQLiteToolExecutionPolicyStore`.
- Consumes: the existing shared `agent.db` connection and repository store conventions.

- [x] **Step 1: Define the policy domain contract and stable errors**

Implement the approved fields, normalized string arrays, limits, command program rules, and errors with codes `TOOL_POLICY_NOT_FOUND`, `TOOL_POLICY_DISABLED`, `TOOL_POLICY_DENIED`, and `INVALID_TOOL_POLICY`.

- [x] **Step 2: Implement strict policy validation**

Reject empty or duplicate IDs, unknown tool IDs when a catalog is supplied, invalid roots, invalid command modes, empty executable rules, duplicate executables, contradictory flag rules, invalid path indexes, timeout values outside `100..600000`, and output limits outside `1024..10485760`.

- [x] **Step 3: Add SQLite storage**

Create `tool_execution_policies` with `id`, `name`, `enabled`, `definition`, `created`, and `updated`; implement list, get, save, and delete using JSON serialization and validation on read/write.

- [x] **Step 4: Add focused domain and persistence tests**

Cover valid normalization, every structural rejection class, CRUD round trips, overwrite timestamps, disabled records, and malformed persisted JSON.

### Task 2: Generic Enforcement Executor

**Files:**
- Create: `packages/core/src/domain/tool/policy-executor.ts`
- Create: `packages/core/src/domain/tool/policy-executor.test.ts`
- Modify: `packages/core/src/domain/tool/permissions.ts`
- Modify: `packages/core/src/domain/agent/AgentBuilder.ts`

**Interfaces:**
- Consumes: `ToolExecutionPolicy`, `IToolExecutor`, `ToolContext`, and the existing `PermissionAwareToolExecutor`.
- Produces: `PolicyAwareToolExecutor`, `resolvePolicyPath`, and `withToolExecutionPolicy(policy)` on `AgentBuilder`.

- [x] **Step 1: Implement canonical filesystem guards**

Resolve relative paths from `ToolContext.workingDirectory`, canonicalize existing targets with `realpath`, canonicalize a missing write target through its existing parent, and require containment in a canonical read or write root. Reject `..`, absolute escapes, and symlink escapes with a redacted `TOOL_POLICY_DENIED` result.

- [x] **Step 2: Implement restricted command parsing and execution**

Tokenize a single simple command with quote and escape support, reject all shell operators and assignments, match an exact executable rule, validate subcommands, flags, declared path flags and positional path indexes, build the configured environment allowlist, execute with `spawn(..., { shell: false })`, and enforce timeout plus combined output truncation.

- [x] **Step 3: Enforce tool and network policy before approval**

Reject tools outside `allowedTools`; classify filesystem reads/writes and network/MCP calls; fail closed for unknown dynamic tools under a restrictive policy; then delegate allowed calls to the existing permission-aware executor.

- [x] **Step 4: Connect the wrapper in AgentBuilder**

Compose executors in the order `PolicyAwareToolExecutor -> PermissionAwareToolExecutor -> ToolRegistry` so policy denial always precedes approval and an absent policy leaves the current behavior intact.

- [x] **Step 5: Add focused executor tests**

Cover tool intersection, traversal, symlink escape, empty write roots, shell operators, executable and subcommand allowlists, flags and path arguments, minimal environment, timeout, output truncation, network denial, MCP denial, and proof that approval is not requested for a denied call.

### Task 3: Shared Run Admission And Flow Protocol

**Files:**
- Modify: `packages/core/src/application/agent-run/StartAgentRunUseCase.ts`
- Modify: `packages/core/src/application/agent-run/StartAgentRunUseCase.test.ts`
- Modify: `packages/server/lib/shared-run-config.ts`
- Modify: `packages/server/lib/shared-run-config.test.ts`
- Modify: `packages/server/app/api/agent/run/route.ts`
- Modify: `packages/server/app/api/flow/v1/runs/route.ts`
- Modify: `packages/server/lib/flow-protocol.ts`
- Modify: `packages/server/lib/flow-protocol.test.ts`

**Interfaces:**
- Consumes: `ToolExecutionPolicyStore.get(id)` and `AgentBuilder.withToolExecutionPolicy(policy)`.
- Produces: optional `toolPolicyId` on `AgentRunCapabilitySelection` and `FlowRunSelection`, plus `toolPolicies` summaries in the Flow catalog.

- [x] **Step 1: Resolve policy before Session creation**

Extend the use-case catalog with a policy resolver; reject missing or disabled policies before `sessions.create`, and pass a cloned validated policy to the run adapter.

- [x] **Step 2: Apply the policy in every shared run builder**

Extend `SharedRunOptions` with `toolExecutionPolicy` and call `withToolExecutionPolicy` without changing empty capability array behavior.

- [x] **Step 3: Extend the HTTP contracts**

Accept a bounded `selection.toolPolicyId`, validate it through the shared store, include policy summaries in `/api/flow/v1/catalog`, and map policy errors to their stable HTTP statuses.

- [x] **Step 4: Update protocol and application tests**

Prove omitted policy compatibility, unknown and disabled admission rejection without Session creation, catalog summaries, request parsing, and adapter propagation.

### Task 4: Customer Agent Policy Management Surface

**Files:**
- Create: `packages/server/lib/tool-execution-policies.ts`
- Create: `packages/server/app/api/tool-policies/route.ts`
- Create: `packages/server/app/api/tool-policies/[policyId]/route.ts`
- Create: `packages/server/app/api/tool-policies/route.test.ts`
- Modify: `packages/desktop/renderer/components/SettingsPanel.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `SQLiteToolExecutionPolicyStore` and `validateToolExecutionPolicy`.
- Produces: authenticated list/create/update/delete JSON endpoints and a generic desktop settings editor.

- [x] **Step 1: Implement the policy service and authenticated CRUD routes**

List full policies for Customer Agent settings, create/update only validated definitions, return `409` for duplicate create IDs, and reject deletion when the requested record is absent.

- [x] **Step 2: Add the desktop settings editor**

Add a Tool Policies section that supports list, create, edit, enable/disable, delete, tool selection, read/write roots, command/network modes, executable rule editing, inherited environment, timeout, and output limit without business-specific labels.

- [x] **Step 3: Add route and UI contract tests**

Cover CRUD success, validation failure, duplicate IDs, missing records, and static UI assertions for every approved policy field.

### Task 5: Flow Studio Selection And Runtime Forwarding

**Files:**
- Modify: `/Users/caoqu/agent-free/src/flow_studio/external_agent.py`
- Modify: `/Users/caoqu/agent-free/src/flow_studio/agentrt.py`
- Modify: `/Users/caoqu/agent-free/src/flow_studio/web/app.js`
- Modify: `/Users/caoqu/agent-free/src/flow_studio/default_agents.json`
- Modify: `/Users/caoqu/agent-free/tests/test_flow_external_agent.py`
- Modify: `/Users/caoqu/agent-free/tests/test_flow_platform.py`
- Modify: `/Users/caoqu/agent-free/tests/test_flow_server.py`

**Interfaces:**
- Consumes: `catalog.toolPolicies[].id/name` and the Flow run `selection.toolPolicyId` field.
- Produces: `selection.tool_policy_id` in a saved external Agent and `toolPolicyId` in Customer Agent run requests.

- [x] **Step 1: Preserve policy selection in Agent normalization and persistence**

Normalize `tool_policy_id` as an optional catalog-backed string in external Agent selections and carry it through legacy upgrade without inventing a default.

- [x] **Step 2: Add policy selection to the external Agent editor**

Render a select populated from the pulled Customer Agent catalog, store only the selected ID, preserve the value across refreshes, and flag a stale policy ID before save.

- [x] **Step 3: Forward the selected policy at runtime**

Map `tool_policy_id` to `selection.toolPolicyId` in `CustomerAgentProvider.run()` and keep it absent when no policy is selected.

- [x] **Step 4: Add Flow Studio tests**

Cover catalog parsing, editor contract, save/load round trip, legacy compatibility, runtime forwarding, and an absent-policy request.

### Task 6: Remove Business-Specific Customer Agent Tools And Configure The Generic Profile

**Files:**
- Modify: `packages/server/lib/shared-run-config.ts`
- Modify: `packages/server/lib/flow-protocol.ts`
- Modify: `packages/server/lib/portfolio-skill-catalog.ts`
- Delete when no longer referenced: `packages/server/lib/portfolio-content-agent.ts`
- Modify: related Customer Agent tests
- Modify: `/Users/caoqu/agent-free/src/flow_studio/default_agents.json`
- Modify: persisted Flow Studio Agent data through its supported API or store service

**Interfaces:**
- Consumes: generic `bash`, `read_file`, `grep`, `glob`, stored policy selection, and the existing `wiki-query` Skill.
- Produces: no Customer Agent registration path for `public_wiki_query` or `wiki_query`; the homepage Agent references generic tools plus one stored generic read-only policy.

- [x] **Step 1: Remove Wiki-specific tool classes and registration**

Delete imports, registrations, catalog exposure, and tests that require `public_wiki_query` or `wiki_query`, while preserving Skill discovery and all unrelated portfolio artifact logic.

- [x] **Step 2: Create a reusable read-only policy through the policy service**

Configure read roots and exact executable rules needed by the installed Skill as policy data, with writes and network denied and bounded timeout/output. Do not encode the data source or command names in implementation branches.

- [x] **Step 3: Migrate the homepage external Agent selection**

Replace the dedicated query tool with generic `bash`, `read_file`, `grep`, and `glob`, save the new `tool_policy_id`, keep the four existing Skills and memory/MCP settings, and publish the updated configuration through Flow Studio's supported lifecycle.

- [x] **Step 4: Add source-boundary checks**

Scan the generic policy implementation and run configuration for homepage, portfolio, Wiki, QMD, GraphRAG, fixed Agent ID, and fixed Flow ID branches; any remaining business terms must be confined to Skills, migration data, or tests that assert removal.

### Task 7: Runtime And Security Verification

**Files:**
- Modify only when failures expose implementation defects.

**Interfaces:**
- Consumes: running Customer Agent, Flow Studio, published homepage Flow, and configured policy.
- Produces: concrete run IDs and event evidence for allowed retrieval and denied access.

- [x] **Step 1: Verify allowed Skill-driven retrieval**

Run the configured Flow and confirm the Agent loads `wiki-query`, invokes only generic allowed tools, and executes its configured QMD or GraphRAG command through restricted Bash.

- [x] **Step 2: Verify deterministic policy denials**

Submit controlled runs that attempt an unrelated executable, a shell pipe/redirection, a write, a path traversal, a symlink escape, and a network/MCP call; confirm `TOOL_POLICY_DENIED`, no approval prompt, and no side effect.

- [x] **Step 3: Verify backward compatibility**

Run an existing request without `toolPolicyId` and confirm current tool and approval behavior remains unchanged.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
cd /Users/caoqu/team-agent/customer-agent
bun test packages/core/src/domain/tool/execution-policy.test.ts packages/core/src/domain/tool/policy-executor.test.ts packages/core/src/infrastructure/SQLiteToolExecutionPolicyStore.test.ts packages/core/src/application/agent-run/StartAgentRunUseCase.test.ts packages/server/lib/shared-run-config.test.ts packages/server/lib/flow-protocol.test.ts packages/server/app/api/tool-policies/route.test.ts
bun run --filter @agent/core build
bun run --filter @agent/server build

cd /Users/caoqu/agent-free
pytest -q tests/test_flow_external_agent.py tests/test_flow_platform.py tests/test_flow_server.py tests/test_homepage_flow.py
```

Expected: all commands pass. If a test fails, fix the implementation or test and rerun this command until it passes. Report the exact command and result in the final response.
