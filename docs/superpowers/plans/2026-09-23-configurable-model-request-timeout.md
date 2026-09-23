# Configurable Model Request Timeout Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each model Profile's whole-request timeout configurable while preserving provider defaults and the independent 60-second stream-chunk timeout.

**Architecture:** Store an optional timeout in seconds on `ModelProfile`, validate it at the shared settings boundary, and convert it to milliseconds only when constructing a model provider. Each provider owns its existing default and emits a stable `model_request_timeout` stream error when the configured whole-request deadline expires.

**Tech Stack:** TypeScript, React, Vitest, Bun workspaces, Next.js server, SQLite-backed shared settings.

## Global Constraints

- Profile field: `requestTimeoutSeconds?: number`.
- Accepted configured range: integer `30` through `1800` seconds.
- Defaults when unset: OpenAI `300`, DeepSeek `300`, Anthropic `120`, AI Hub `240` seconds.
- Keep the existing 60-second no-stream-chunk timeout unchanged.
- Preserve already-streamed reasoning and text, emit `code: "model_request_timeout"`, and do not emit successful completion after a whole-request timeout.
- Configure the persisted `step-5-preview` Profile to `600` seconds without replacing its secret or changing the active Profile.

---

### Task 1: Profile Contract And Validation

**Files:**
- Modify: `packages/core/src/domain/settings/entities.ts`
- Modify: `packages/server/lib/shared-settings.ts`
- Unit tests: `packages/server/lib/shared-settings.test.ts`

**Interfaces:**
- Consumes: Existing `ModelProfile` persistence through `SharedSettingsService.save()`.
- Produces: Optional `requestTimeoutSeconds?: number`, persisted only when present and constrained to `30..1800`.

- [x] **Step 1: Add the Profile field**

Add `requestTimeoutSeconds?: number` to `ModelProfile` with a comment that unset values preserve provider defaults.

- [x] **Step 2: Validate and persist the field**

Reject non-integers and values outside `30..1800`; copy valid values into the sanitized Profile object.

- [x] **Step 3: Cover valid and invalid boundaries**

Extend the shared settings test with a valid 600-second value and rejection checks below 30 and above 1800.

### Task 2: Provider Deadline Behavior

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/core/src/domain/agent/AgentBuilder.ts`
- Create: `packages/core/src/domain/model/providers/requestTimeout.ts`
- Modify: `packages/core/src/domain/model/providers/OpenAIProvider.ts`
- Modify: `packages/core/src/domain/model/providers/DeepSeekProvider.ts`
- Modify: `packages/core/src/domain/model/providers/AnthropicProvider.ts`
- Modify: `packages/core/src/domain/model/providers/AiHubProvider.ts`
- Unit tests: `packages/core/src/domain/model/providers/__tests__/OpenAIProvider.test.ts`
- Unit tests: `packages/core/src/domain/model/providers/__tests__/AnthropicProvider.test.ts`

**Interfaces:**
- Consumes: `ModelProviderConfig.timeoutMs?: number` passed by `AgentBuilder.withModel()`.
- Produces: Provider-specific defaults plus a stable timeout event `{ type: "error", code: "model_request_timeout", message }`.

- [x] **Step 1: Generalize the provider configuration**

Allow `AgentBuilder.withModel()` to accept `timeoutMs` and document `ModelProviderConfig.timeoutMs` as the whole-request deadline for every provider.

- [x] **Step 2: Apply provider defaults and configured values**

Store `config.timeoutMs` in OpenAI, DeepSeek, and Anthropic providers using defaults of `300_000`, `300_000`, and `120_000`; continue using AI Hub's `240_000` default.

- [x] **Step 3: Normalize timeout failures**

Wrap the initial fetch and stream read deadline failures so they return `model_request_timeout`; retain accumulated output and omit `text_done`. On an AI Hub deadline with captured text, emit text chunks followed by the timeout error without parsing or executing a possibly incomplete tool envelope.

- [x] **Step 4: Test configured milliseconds and timeout events**

Assert the configured timeout reaches `AbortSignal.timeout`, and simulate initial request timeouts for OpenAI-compatible and Anthropic providers to verify the stable code and absence of `text_done`.

### Task 3: Runtime Propagation And Settings UI

**Files:**
- Modify: `packages/server/lib/shared-run-config.ts`
- Unit tests: `packages/server/lib/shared-run-config.test.ts`
- Modify: `packages/desktop/main/agent-host.ts`
- Modify: `packages/native-runtime/src/sub-agent-dispatcher.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/renderer/components/SettingsPanel.tsx`
- Modify: `packages/webapp/src/infrastructure/local/local-settings-repository.ts`

**Interfaces:**
- Consumes: `ModelProfile.requestTimeoutSeconds` from active, selected, or agent-bound Profiles.
- Produces: `timeoutMs = requestTimeoutSeconds * 1000` at every Profile-backed `withModel()` call; a settings input labeled `单次请求超时（秒）`.

- [x] **Step 1: Propagate selected Profile values**

Include `requestTimeoutSeconds` in shared run model resolution and convert it to milliseconds before provider construction in server, desktop, and native sub-agent paths.

- [x] **Step 2: Add the Profile editor control**

Add provider defaults (`120`, `300`, `300`, `240`), initialize new Profiles with the provider default, update the value on provider switches, validate `30..1800`, and show the effective seconds in the Profile summary.

- [x] **Step 3: Preserve web model overrides**

Include the optional timeout in `LocalSettingsRepository.getModelOverride()` so explicit local Profiles retain the same contract.

- [x] **Step 4: Test resolved Profile propagation**

Extend `resolveSharedRunModel` assertions to include a 600-second configured timeout.

### Task 4: Build, Persist, And Runtime Verification

**Files:**
- Modify through revisioned API: server settings database Profile `step-5-preview`
- Build outputs: workspace-generated artifacts only

**Interfaces:**
- Consumes: Revisioned `GET/POST /api/settings` contract and the existing launchd-managed port 3000 service.
- Produces: Running server build with `step-5-preview.requestTimeoutSeconds = 600`.

- [x] **Step 1: Build affected workspaces**

Build core, native runtime, webapp, and the production server using Node 22 and the release skill's safe-delete override.

- [x] **Step 2: Update the persisted Profile safely**

Read the public settings revision, submit the complete Profiles list with only `step-5-preview.requestTimeoutSeconds` changed to `600`, and keep stored-secret markers and `activeProfileId` intact.

- [x] **Step 3: Restart and verify port 3000**

Restart the launchd job, verify one stable listener, `/web`, `/api/agent/runtime-health`, and `/api/sessions`, then confirm `/api/settings` returns 600 seconds for `step-5-preview`.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/core/src/domain/model/providers/__tests__/OpenAIProvider.test.ts packages/core/src/domain/model/providers/__tests__/AnthropicProvider.test.ts packages/server/lib/shared-settings.test.ts packages/server/lib/shared-run-config.test.ts`

Expected: PASS. Then run affected workspace TypeScript builds and `git diff --check`; fix and rerun until clean.
