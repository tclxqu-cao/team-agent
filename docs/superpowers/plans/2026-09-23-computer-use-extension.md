# Customer Agent Computer Use Extension Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default, single-action, Accessibility-first macOS `computer` model tool to Customer Agent while leaving Codex, Claude Code, and OpenCode native runtimes unchanged.

**Architecture:** A new `@agent/computer-use` workspace package owns the platform-neutral action contract, orchestration use cases, tool adapter, and local relay client. Electron owns the macOS Accessibility, screen capture, input, ownership, and Unix-socket relay adapters; Server registers the tool only in the Customer Agent composition root. Core gains generic direct-execution metadata and ephemeral model attachments without importing the extension.

**Tech Stack:** TypeScript, Zod, Bun workspaces, Vitest, Electron `desktopCapturer`, Node Unix sockets, Swift/AppKit/ApplicationServices/CoreGraphics.

## Global Constraints

- macOS only in the first release; other platforms report the extension unavailable.
- Register `computer` only for Customer Agent; do not modify Codex, Claude Code, or OpenCode native runtime adapters.
- Call `computer` only when the user explicitly requests computer operation or the task cannot continue without GUI observation/interaction; otherwise do not call it.
- Prefer existing file, Shell, API, and browser-specific tools whenever they can complete the task; never call `computer` speculatively or merely for convenience.
- Execute exactly one action per tool invocation.
- Prefer the frontmost application's Accessibility tree; use a screenshot only when AX is unavailable or unusable, or when the model explicitly requests `screenshot` after a partial tree.
- Do not show a Customer Agent approval dialog for `computer`; macOS Accessibility and Screen Recording permissions remain authoritative.
- AX snapshots are limited to 500 nodes, depth 20, 40,000 aggregate text characters, and 1.5 seconds.
- Relay requests time out after 8 seconds; `wait` is limited to 5 seconds; typed text is limited to 10,000 characters.
- Screenshot data is limited to 4 MiB; relay request lines to 128 KiB; relay response lines to 6 MiB.
- Secure text values, screenshot Base64, and raw AX trees must not be persisted to SQLite, public events, logs, or compaction checkpoints.
- Node identifiers are revision-bound; a new observation invalidates all previous node identifiers.
- While desktop ownership is `handoff-requested`, `user-controlled`, `return-requested`, or `resyncing`, observations remain available and mutating actions fail with `desktop_controlled_by_user`.

---

### Task 1: Scaffold The Computer Use Workspace Package

**Files:**
- Create: `packages/computer-use/package.json`
- Create: `packages/computer-use/tsconfig.json`
- Create: `packages/computer-use/src/index.ts`
- Create: `packages/computer-use/src/domain/computer-action.ts`
- Create: `packages/computer-use/src/domain/computer-observation.ts`
- Create: `packages/computer-use/src/domain/observation-policy.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `packages/server/package.json`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Consumes: `ITool`, `ToolContext`, and `ToolResult` from `@agent/core`.
- Produces: `ComputerAction`, `ComputerObservation`, `ComputerErrorCode`, `ComputerRuntimePort`, and `ObservationSelectionPolicy` exports from `@agent/computer-use`.

- [x] **Step 1: Add the package build and TypeScript configuration**

Use the package name `@agent/computer-use`, ESM output at `dist/index.js`, declaration output at `dist/index.d.ts`, and this build command:

```json
"build": "bun build ./src/index.ts --outdir ./dist --target node --format esm --sourcemap=external --external @agent/core && bunx tsc --emitDeclarationOnly"
```

The package `tsconfig.json` extends the root config, sets `rootDir` to `src`, and maps `@agent/core` to `../core/dist` so declaration generation does not emit into Core.

- [x] **Step 2: Define the strict single-action schema and observation types**

Export `computerActionSchema` and the flat `ComputerAction` union covering `observe`, `press`, `click`, `double_click`, `type`, `keypress`, `scroll`, `move`, `drag`, `wait`, and `screenshot`. Refine click/scroll so exactly one target mode is present: a revision-bound `nodeId` or complete coordinates.

```ts
export interface ComputerRuntimePort {
  status(signal?: AbortSignal): Promise<{ available: boolean; platform?: string; vision?: boolean }>;
  execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation>;
}
```

- [x] **Step 3: Implement AX-first observation selection**

`ObservationSelectionPolicy.select(axResult)` returns meaningful AX snapshots, preserves partial snapshots without an automatic screenshot, and asks the runtime for a screenshot only for denied, timed-out, empty, or unusable snapshots.

- [x] **Step 4: Wire workspace dependencies and root paths/build order**

Add the workspace, root `@agent/computer-use` paths, build it after Core and before Server/Desktop, and add `"@agent/computer-use": "*"` to Server and Desktop.

- [x] **Step 5: Add focused schema and policy tests**

Create `packages/computer-use/src/domain/computer-action.test.ts` and `observation-policy.test.ts` covering every valid action, ambiguous target rejection, size limits, meaningful AX preference, partial AX preservation, and screenshot fallback triggers.

### Task 2: Add Generic Tool Authorization Metadata

**Files:**
- Modify: `packages/core/src/domain/tool/entities.ts`
- Modify: `packages/core/src/domain/tool/ToolRegistry.ts`
- Modify: `packages/core/src/domain/tool/permissions.ts`
- Modify: `packages/core/src/domain/tool/permissions.test.ts`

**Interfaces:**
- Consumes: existing `IToolExecutor` and `ToolPermissionGate`.
- Produces: `ToolAuthorizationPolicy = "default" | "direct"`, optional `ITool.authorization`, and `IToolExecutor.getAuthorizationPolicy(name)`.

- [x] **Step 1: Add generic authorization policy metadata**

Add `readonly authorization?: ToolAuthorizationPolicy` to `ITool`; `ToolRegistry.getAuthorizationPolicy(name)` returns the registered tool's policy or `"default"`.

- [x] **Step 2: Bypass the approval gate for direct tools**

`PermissionAwareToolExecutor.execute()` checks the delegate policy before calling `gate.authorize`; `direct` invokes the delegate immediately. Forward the policy method through executor decorators.

- [x] **Step 3: Prove direct execution is generic**

Extend permission tests with an arbitrary direct tool name and verify no approval request occurs in request-approval mode; retain existing unknown-tool approval behavior.

### Task 3: Add Ephemeral Model Attachments

**Files:**
- Modify: `packages/core/src/domain/model/entities.ts`
- Modify: `packages/core/src/domain/agent/AgentLoop.ts`
- Modify: `packages/core/src/domain/agent/__tests__/AgentLoop.test.ts`
- Modify: `packages/core/src/domain/model/providers/OpenAIProvider.ts`
- Modify: `packages/core/src/domain/model/providers/AnthropicProvider.ts`
- Modify: `packages/core/src/domain/model/providers/DeepSeekProvider.ts`
- Modify: `packages/core/src/domain/model/providers/AiHubProvider.ts`
- Modify: provider test files under `packages/core/src/domain/model/providers/__tests__/`

**Interfaces:**
- Consumes: existing `Message.images` provider adapters.
- Produces: `ToolResult.modelContent?: string`, `ToolResult.modelAttachments?: ModelAttachment[]`, and a transient `Message` named `__tool_observation__` after all tool messages.

- [x] **Step 1: Define generic image attachments**

```ts
export interface ModelAttachment {
  type: "image";
  mimeType: "image/jpeg" | "image/png";
  dataUrl: string;
  width?: number;
  height?: number;
}
```

- [x] **Step 2: Append one transient observation after complete tool batches**

After all assistant tool calls have matching tool messages, collect attachments and append one user message with call IDs plus `images`. Sanitize the public `tool_result` event to attachment descriptors only and strip `modelAttachments` before events, diagnostics, checkpoints, session persistence, and compaction checkpoint persistence.

- [x] **Step 3: Adapt vision-capable providers generically**

OpenAI and Anthropic reuse user-message image handling. AIHub's image selection accepts the latest transient tool observation as well as the latest user turn. DeepSeek rejects any image-bearing message with a stable `vision_unavailable` error before network dispatch.

- [x] **Step 4: Test ordering and non-persistence**

Verify OpenAI-compatible order is assistant tool calls, every tool result, then one image user observation; verify public events/checkpoints contain no Base64; verify OpenAI, Anthropic, and AIHub receive the image; verify DeepSeek does not call fetch.

### Task 4: Implement The Computer Tool And Relay Client

**Files:**
- Create: `packages/computer-use/src/ports/computer-runtime-port.ts`
- Create: `packages/computer-use/src/application/observe-computer.ts`
- Create: `packages/computer-use/src/application/execute-computer-action.ts`
- Create: `packages/computer-use/src/interface/computer-tool.ts`
- Create: `packages/computer-use/src/infrastructure/relay-protocol.ts`
- Create: `packages/computer-use/src/infrastructure/relay-client.ts`
- Unit tests: matching `*.test.ts` files in the same package directories

**Interfaces:**
- Consumes: `ComputerRuntimePort.execute(action, signal)`.
- Produces: `ComputerTool`, `ComputerRelayClient`, `resolveComputerRelaySocketPath`, and bounded request/response codecs.

- [x] **Step 1: Implement serialized application use cases**

`ExecuteComputerActionUseCase` validates one action, forwards AbortSignal, and maps runtime failures to the documented structured error codes. `ObserveComputerUseCase` invokes `{ action: "observe" }`.

- [x] **Step 2: Implement the model-facing tool**

`ComputerTool` has `name = "computer"`, `authorization = "direct"`, the strict JSON schema, AX-first guidance in its description, concise JSON text output, and screenshot attachments only when the observation source is `screenshot`.

- [x] **Step 3: Implement the bounded Unix-socket client**

Use JSON-lines request IDs, an 8-second timeout, a 128 KiB outbound limit, a 6 MiB inbound limit, offline/timeout/protocol error mapping, and AbortSignal cancellation. Status probing is independent of execution.

- [x] **Step 4: Test action forwarding, errors, limits, and abort**

Use a temporary Unix socket fixture to prove request IDs, status, successful observations, structured errors, oversized response rejection, timeout, and cancellation.

### Task 5: Extend The Persistent Swift Helper With AX Snapshots

**Files:**
- Modify: `packages/desktop/native/desktop-input.swift`
- Modify: `packages/desktop/main/desktop-input-gateway.ts`
- Modify: `packages/desktop/main/desktop-input-gateway.test.ts`

**Interfaces:**
- Consumes: existing JSON-lines helper process and CGEvent operations.
- Produces: helper operations `ax_snapshot`, `ax_action`, and `ax_focus` plus typed gateway commands/results.

- [x] **Step 1: Traverse the frontmost focused AX surface**

Resolve the frontmost app and focused window/dialog/menu, traverse allowlisted attributes breadth-first with cycle protection, redact secure values, cap nodes/depth/text/time, and return a new `ax_<counter>` revision with ephemeral `AXUIElement` registry entries.

- [x] **Step 2: Execute revision-bound semantic actions**

Reject mismatched revisions as `stale_observation`; perform AXPress, AXRaise, and focused-value actions only on current registry nodes; report `node_not_found` and `action_not_supported` distinctly.

- [x] **Step 3: Preserve all existing input operations**

Keep `check`, mouse, wheel, key, text, and hit-test wire shapes backward compatible. Add gateway test cases showing old commands and new AX commands share the same persistent process safely.

- [x] **Step 4: Compile and smoke the helper directly**

Build with the existing Desktop script/toolchain, send `check` and `ax_snapshot` JSON lines, and verify a parseable response from the active macOS desktop.

### Task 6: Build The Electron macOS Runtime

**Files:**
- Create: `packages/desktop/main/computer-use/mac-accessibility-adapter.ts`
- Create: `packages/desktop/main/computer-use/electron-screen-capture-adapter.ts`
- Create: `packages/desktop/main/computer-use/desktop-input-adapter.ts`
- Create: `packages/desktop/main/computer-use/desktop-computer-runtime.ts`
- Unit tests: matching `*.test.ts` files
- Modify: `packages/desktop/main/desktop-screen-screencast.ts`
- Modify: `packages/desktop/main/desktop-screen-screencast.test.ts`

**Interfaces:**
- Consumes: `DesktopInputGateway`, `desktopCapturer`, display metadata, and live-view ownership state.
- Produces: `DesktopComputerRuntime.execute(action, signal)` and reusable `captureDesktopFrame()`.

- [x] **Step 1: Extract deterministic one-frame capture**

Return bounded JPEG bytes, pixel dimensions, logical viewport, scale, and global display origin. Keep existing remote screencast pacing and frame behavior unchanged by delegating its capture loop to the new primitive.

- [x] **Step 2: Adapt AX and input operations**

Prefer AXPress for node actions, fall back to the node center only when the action contract permits it, focus before typing, convert screenshot pixels to global logical coordinates, and implement complete down/move/up drag cleanup on abort.

- [x] **Step 3: Enforce ownership and global serialization**

One runtime-wide promise queue owns actions across sessions. Observation is always allowed; mutation checks the live-view state immediately before execution and returns `desktop_controlled_by_user` for takeover states.

- [x] **Step 4: Return fresh observations**

Every successful mutation and wait settles briefly, then observes again. Automatic screenshot fallback occurs only for unusable AX; explicit `screenshot` always captures. Missing permissions use `accessibility_denied` or `screen_recording_denied`.

The Electron composition root injects the macOS lock state. Runtime status reports `desktopLocked`, and every observation or mutation fails closed with `desktop_locked`; `wait` rechecks after its delay before observing.

- [x] **Step 5: Test Retina, secondary-display, ownership, abort, and fallback behavior**

Use injected gateways/capture functions so tests assert coordinate conversion, action ordering, stale revisions, screenshot size, global serialization, no mutation during phone control, and no observation or mutation while the Mac is locked.

### Task 7: Host The Computer Relay In Electron

**Files:**
- Create: `packages/desktop/main/computer-use/computer-relay-server.ts`
- Create: `packages/desktop/main/computer-use/computer-relay-server.test.ts`
- Modify: `packages/desktop/main/index.ts`

**Interfaces:**
- Consumes: `DesktopComputerRuntime` and the existing Electron single-instance lifecycle.
- Produces: a private `computer-relay.sock` serving `status` and `execute` requests.

- [x] **Step 1: Implement a private bounded relay**

Create the parent directory as `0700`, socket as `0600`, remove stale sockets only after the app owns the single-instance lock, enforce line limits, echo request IDs, and expose no arbitrary commands.

- [x] **Step 2: Wire startup and shutdown**

Start after `app.whenReady()` with the shared input gateway, capture adapter, and ownership provider. Close the relay and helper and remove the socket on `before-quit`.

- [x] **Step 3: Test malformed requests and lifecycle cleanup**

Cover bad JSON, unsupported message type, request overflow, structured runtime failure, socket mode, concurrent clients, and close/unlink behavior.

### Task 8: Register Only In Customer Agent Server Runs

**Files:**
- Create: `packages/server/lib/computer-use.ts`
- Create: `packages/server/lib/computer-use.test.ts`
- Modify: `packages/server/app/api/agent-host.ts`
- Modify: `packages/server/app/api/agent-host.test.ts`

**Interfaces:**
- Consumes: `ComputerRelayClient.status()` and `ComputerTool`.
- Produces: conditional `registerCustomerComputerTool(builder)` composition-root helper.

- [x] **Step 1: Probe and register during Customer Agent composition**

Register `computer` only when the desktop relay reports `available: true`, `platform: "darwin"`, and a compatible protocol version. Keep desktop-disconnect failures as `desktop_offline` tool results after registration.

- [x] **Step 2: Keep native runtime paths untouched**

Tests must prove a Customer Agent builder receives the tool while `NativeRuntimeService` construction, Codex, Claude Code, and OpenCode adapters have no `@agent/computer-use` imports or registrations.

- [x] **Step 3: Prove no CA approval prompt and no image persistence**

Run request-approval mode with a fake relay screenshot, assert the tool executes without `ask_user`, and assert stored events/messages/checkpoints contain descriptors but no `data:image` payload.

### Task 9: Complete Workspace Packaging Wiring

**Files:**
- Modify: `scripts/stage-cli-runtime.mjs`
- Modify: `scripts/incremental-cli-release.mjs`
- Modify: `scripts/stage-agent-packages-for-packaging.mjs`
- Modify: `scripts/agent-runtime-upgrade-lib.mjs`
- Modify: `scripts/agent-runtime-diff-policy.mjs`
- Modify: related `scripts/*.test.mjs` fixtures
- Modify: `packages/desktop/electron-builder.yml`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `@agent/computer-use` workspace build output.
- Produces: Server runtime and Electron packaging layouts that resolve the package without registry access or escaped symlinks.

- [x] **Step 1: Add package to all build/staging/affected-package lists**

Build after Core and before Server; stage its `dist`; strip all `@agent/*` runtime dependencies from npm install input; include source changes in affected package planning.

- [x] **Step 2: Add upgrade/diff-policy dependency files and fixtures**

Allow and track `packages/computer-use/package.json` wherever native runtime dependency files are enumerated so upgrade guards remain deterministic.

- [x] **Step 3: Add desktop staging and source-map exclusion**

Stage a real package directory rather than an escaping workspace symlink and exclude the package's `.map` files from the final asar.

- [x] **Step 4: Run packaging guard tests**

Run the focused Node test set from the workspace extraction skill and inspect staged Desktop package symlinks.

### Task 10: Runtime Acceptance On macOS

**Current acceptance boundary (2026-09-23):** The deterministic AppKit fixture compiles, and the scripted AgentLoop smoke proves the complete single-action sequence against a deterministic runtime. The live Desktop relay reports Accessibility and Screen Recording denied; its real `observe` therefore falls through to screenshot and returns `screen_recording_denied`. The same live smoke proves compatible registration, direct authorization, transient-observation privacy, structured permission failure, and the real relay/runtime ownership guard. The full Electron -> Swift success path remains unchecked until AgentRoam receives both macOS permissions.

**Files:**
- Create: `packages/desktop/scripts/computer-use-fixture.swift`
- Create: `scripts/computer-use-smoke.mjs`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Consumes: real Server AgentLoop, model-provider fixture, Server relay client, Electron relay, Swift helper, and macOS TCC state.
- Produces: repeatable acceptance output with each contract step and permission state.

- [x] **Step 1: Add a deterministic native fixture**

The fixture exposes an AX text field, button, status label, scroll region, and Canvas-only target. It reports state to stdout or a temporary status file so the smoke script can verify effects.

- [ ] **Step 2: Run the complete Customer Agent tool loop**

Verify `observe`, node `type`, node `press`, refreshed AX values, stale revision rejection, explicit screenshot, coordinate Canvas click, and no approval event through AgentLoop -> Server -> relay -> Electron -> Swift.

- [x] **Step 3: Verify negative permission and ownership paths**

Record live Accessibility and Screen Recording status. If either TCC permission is unavailable, report that exact runtime limit while still proving the other paths. Simulate phone ownership through the real ownership provider and prove observation succeeds while mutation fails.

- [x] **Step 4: Verify provider screenshot delivery**

Use request-capture provider stubs for OpenAI/Anthropic/AIHub and a DeepSeek no-network stub to prove the transient image contract independently of external credentials.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
export PATH="/Users/caoqu/.bun/bin:/opt/homebrew/bin:$PATH"
bunx vitest run packages/computer-use packages/core/src/domain/tool/permissions.test.ts packages/core/src/domain/agent/__tests__/AgentLoop.test.ts packages/core/src/domain/model/providers packages/desktop/main/computer-use packages/desktop/main/desktop-input-gateway.test.ts packages/desktop/main/desktop-screen-screencast.test.ts packages/server/lib/computer-use.test.ts packages/server/app/api/agent-host.test.ts
bun run --cwd packages/core build
bun run --cwd packages/computer-use build
bunx tsc --noEmit -p packages/computer-use
bunx tsc --noEmit -p packages/server
bunx tsc --noEmit -p packages/desktop
node --test scripts/agent-runtime-upgrade.test.mjs scripts/check-agent-runtime-diff.test.mjs scripts/incremental-cli-release.test.mjs scripts/publish-agentroam-release.test.mjs scripts/agent-runtime-workflow-contract.test.mjs scripts/agent-runtime-github-setup.test.mjs
```

Expected: all focused tests, builds, and type checks pass; the macOS runtime smoke reports each executed action and any TCC-limited step separately.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
