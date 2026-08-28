# TUI Model Configuration Wizard Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive `/model` wizard that stores an OpenAI-compatible endpoint, API key, discovered models, and default model, then exposes all discovered models in the existing keyboard-driven model palette.

**Architecture:** Extend the versioned TUI config with custom endpoint records and an active model reference. Keep HTTP discovery in a focused module and model-wizard state/rendering in focused components; `App.tsx` coordinates those units and switches the existing `TuiRuntime` only after configuration succeeds.

**Tech Stack:** Bun, TypeScript, React 18, Ink 5, Vitest, native `fetch`.

## Global Constraints

- Persist `~/.customer-agent-tui/config.json` atomically with file mode `0600`.
- API keys are intentionally persisted in this file per the user's selected storage option, but must never appear in transcript, input history, errors, or model labels.
- Treat custom endpoints as OpenAI-compatible and use provider id `openai`.
- Accept either a base URL or a full `/models` URL; normalize chat requests to the base expected by `OpenAIProvider`.
- Preserve Desktop profiles and environment-based startup fallback.
- Preserve cached discovered models when refresh fails.

---

### Task 1: Persistent Custom Model Endpoints

**Files:**
- Modify: `packages/tui/src/model-config.ts`
- Unit tests: `packages/tui/src/model-config.test.ts`

**Interfaces:**
- Produces: `TuiConfig`, `CustomModelEndpoint`, `loadTuiConfig()`, `saveTuiConfig()`, `endpointModelSelection()`.

- [x] **Step 1: Define a versioned config schema**

Store `version`, optional active selection, and `endpoints[]` records containing id, name, base URL, API key, default model id, cached model ids, and last refresh time.

- [x] **Step 2: Preserve legacy config compatibility**

Read the existing single-selection format and expose it through the same startup resolution path without discarding Desktop or environment fallbacks.

- [x] **Step 3: Persist atomically with mode 0600**

Write through a process-specific temporary file, chmod it to `0600`, and rename it over the destination.

- [x] **Step 4: Test round-trip, permissions, migration, and secret handling**

Assert custom endpoints survive restart, the selected default model resolves with its endpoint credentials, and the serialized key is absent from any display helper output.

### Task 2: OpenAI-Compatible Model Discovery

**Files:**
- Create: `packages/tui/src/model-discovery.ts`
- Unit tests: `packages/tui/src/model-discovery.test.ts`

**Interfaces:**
- Produces: `normalizeModelEndpoint(url)`, `fetchAvailableModels({ baseUrl, apiKey, fetch?, timeoutMs? })`.

- [x] **Step 1: Normalize endpoint URLs**

Convert `https://host`, `https://host/v1`, and `https://host/v1/models` into a stored provider base URL plus an exact discovery URL without duplicate `/v1` or `/models` segments.

- [x] **Step 2: Fetch and parse models**

Send `GET` with Bearer authorization when a key is present, apply a bounded timeout, parse OpenAI `{ data: [{ id }] }`, deduplicate ids, and sort them naturally.

- [x] **Step 3: Return actionable failures**

Report invalid URLs, HTTP status, invalid JSON, unsupported response shape, empty model lists, and timeouts without including credentials.

- [x] **Step 4: Test normalization, headers, response parsing, deduplication, and failures**

Use injected fetch responses and fake abort behavior; do not call an external model service in unit tests.

### Task 3: Interactive Wizard and Model Palette

**Files:**
- Create: `packages/tui/src/components/ModelWizard.tsx`
- Create: `packages/tui/src/model-wizard.ts`
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/components/Composer.tsx`
- Modify: `packages/tui/src/theme.ts`
- Unit tests: `packages/tui/src/model-wizard.test.ts`
- Unit tests: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Consumes: config and discovery functions from Tasks 1 and 2.
- Produces: URL step, masked API-key step, fetch status, discovered-model selection, and saved active model.

- [x] **Step 1: Add a small wizard state machine**

Model explicit `url`, `apiKey`, `fetching`, and `model` phases. API-key input renders bullets and bypasses command history and transcript dispatch.

- [x] **Step 2: Add model palette actions**

Place current model first, retain Desktop profiles, add each cached custom model, and add `配置模型服务` plus per-endpoint refresh actions.

- [x] **Step 3: Configure and activate an endpoint**

After URL and key entry, fetch all models, open the discovered-model selector, save the selected model as the endpoint default and global active selection, then call `runtime.switchModel()`.

- [x] **Step 4: Refresh without losing cache**

Update the cached list and timestamp only after successful discovery. On failure, show an error while keeping prior candidates selectable.

- [x] **Step 5: Test keyboard-driven configuration**

Drive `/model`, select configuration, enter URL and API key, verify the key is masked, select a discovered model, and assert persistence plus runtime switching.

### Task 4: Startup Integration and Final Verification

**Files:**
- Modify: `packages/tui/src/main.tsx`
- Modify: `packages/tui/src/model-config.ts`
- Unit tests: `packages/tui/src/model-config.test.ts`

**Interfaces:**
- Consumes: persisted endpoint selection from Task 1.
- Produces: restart-safe default model startup.

- [x] **Step 1: Load the full TUI config at startup**

Resolve the active custom endpoint before Desktop and environment fallbacks, and pass the config/endpoints into `TuiApp`.

- [x] **Step 2: Preserve existing startup failure behavior**

When no persisted, Desktop, or environment model is usable, keep the existing clear configuration error.

- [x] **Step 3: Build Core and smoke-test the global command**

Build `packages/core`, start the globally linked `agent-tui` from Home, and verify `/model` opens the custom endpoint actions without terminal overflow.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/tui/src && bun run --cwd packages/tui typecheck && bunx tsc --noEmit -p packages/core/tsconfig.json`

Expected: all TUI tests pass and both type checks exit 0.
