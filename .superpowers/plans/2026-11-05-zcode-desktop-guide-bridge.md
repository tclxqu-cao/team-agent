# ZCode desktop guide bridge implementation plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a text guide from AgentRoam to a ZCode conversation already running in its desktop owner, preserving the original runtime and session identity.

**Architecture:** The desktop Window Host retains execution, command admission and conversation state. A local authenticated transport exposes the existing connection-scoped command facade to AgentRoam. AgentRoam discovers capabilities before allowing external guide submission and reuses its existing durable queue and command receipt handling. Existing idle continuation and local-run guide behavior remain in their present paths.

**Tech Stack:** TypeScript, ZCode V4 command envelopes, Node local IPC, existing durable broker messages, Vitest and native isolated fixtures.

## Global constraints

- The user explicitly authorized changing both AgentRoam and ZCode. Installed desktop replacement and interruption of existing desktop tasks remain outside source implementation and require a concrete activation boundary.
- This feature handles text guides only. Subagent child sessions remain read-only.
- No second resident, session/resume or session/send is permitted on the external-guide path.
- The native CommandInbox owns accepted input. The bridge owns connection and authentication only, with no independent accepted queue.
- Maintain the original sessionId and workspaceIdentity; do not route by a selected UI workspace or a path alone when an identity is present.
- Stable durable message ID determines commandId. An uncertain ACK is queried against the same native command; it never creates a new input ID.
- A received ACK proves native admission, not execution completion. Keep the guide pending when native admission is unknown or rejected.
- Keep desktop continuous delivery and mobile replayable delivery distinct. Only a successfully probed bridge grants external guide capability.
- Preserve concurrent dirty edits in both checkouts, active tasks, installed applications and current services. Building and activating a modified ZCode desktop requires a separate concrete activation boundary.
- No project docs changes, commits, pushes or package publication in this task. This plan is outside docs by the user's project rule.

## Confirmed existing interfaces

`packages/native-runtime/src/agent-runtime/zcode-steering.ts` submits this existing native envelope and validates commandId/inputId/admission receipts:

```ts
{
  commandId,
  clientId: "agentroam",
  sessionId,
  type: "sendText",
  payload: { text: input, requestedDelivery: "guide" },
  issuedAt: Date.now(),
}
```

In the ZCode checkout, `packages/services/src/zcode-agent/zcodeAgentService.ts` already implements `sendConversationCommandV4` and `queryConversationCommandsV4`. `packages/desktop/src/host/index.ts` exposes a `createZCodeAgentConnectionScope` facade for each attachment. `windowHostAttachmentRegistry.ts` validates scope and generation and reuses existing services.

Current restrictions that must stay authoritative until an actual bridge is available:

- ZCodeClient rejects external running sessions before materializing a second resident.
- UnifiedSessionService.steer requires a locally active run for ZCode.
- ChatView treats externally owned non-Codex sessions as read-only.
- Child sessions retain their intrinsic readOnly flag independently of occupancy.

## Tasks after the scope decision

### 1. Expose the existing desktop owner through an authenticated local transport

- [x] Use ZCode architecture-governance to read the managed desktop Host module's contract, declare the bridge's module boundary and write the behavior spec before source changes.
- [x] Discover the installed desktop's supported external transport first. Reuse an existing authenticated attachment route if confirmed; otherwise implement the bridge on the desktop Host side, never on a newly spawned CLI.
- [x] Route only to the owning workspace and existing running session. An unknown owner, stale Host generation, missing session or child session produces an explicit refusal without materializing a resident.
- [x] Keep the transport cross-platform, private to the current OS user, versioned and bound to a verified live Host. Limit commands to text guide and receipt query; do not expose arbitrary service calls.
- [x] Test wrong authentication, stale owner, wrong workspace identity, unsupported version, duplicate command ID and Host shutdown.

### 2. Connect AgentRoam's durable message to the desktop guide receipt

- [x] Add a focused desktop bridge client to native-runtime. It consumes native session identity and stable message ID and returns the native admission receipt.
- [x] Reuse ZCodeSteering's envelope and ACK rules through a transport abstraction instead of adding a second acceptance implementation.
- [x] Extend external steering only when the bridge confirms the target owner. Keep ordinary run/session creation and local steering behavior unchanged.
- [x] Ensure the broker marks a durable message complete only after matching native admission; preserve the message on rejection or uncertainty.
- [x] Test that external guides call no legacy resume/send, repeated requests do not duplicate input, bridge loss preserves the message, and local-run guides still use the existing stdio transport.

### 3. Enable the phone composer from verified capabilities

- [x] Add a runtime capability for external text guidance, independently of occupancy and intrinsic readOnly.
- [x] Enable the existing guide action for a running external main session only when that capability is present. Show explicit pending/admitted/failure status using existing message queue state.
- [x] Keep child sessions read-only and disable the action when the desktop owner disappears.
- [x] Test capability absent/present, child sessions, late capability responses after session switching, and failed native admission.

### 4. Verify the original desktop-owned trigger before activation

- [ ] In an isolated desktop fixture start a long-running task, submit a text guide through the new bridge, and verify the original process/session consumes the matching command exactly once.
- [ ] Confirm the original task remains active through submission, mobile and desktop observe the same added input and output, and no second runtime is created.
- [ ] Confirm idle main-session continuation still works and child sessions stay read-only.
- [ ] Prepare activation artifacts and report the exact desktop/service restart impact before touching the user's active installed app or broker.

## Final unit test verification

- [x] Main agent: run the affected bridge, ZCode steering/client, unified service, broker, capability and composer tests after implementation; fix failures and rerun the affected set.
- [x] Run native-runtime typecheck and package build. If ZCode source changes are included, run its required typecheck, lint and architecture checks and separate existing failures from introduced failures.
- [ ] Record actual native admission, original owner PID/session identity, event synchronization and completion evidence. Unit fixtures alone do not count as desktop/mobile acceptance.

## Current status

Both-side source implementation is authorized. The bridge uses a private per-Host descriptor under the ZCode data directory and a token-authenticated loopback JSON RPC restricted to probe, V4 text guide and command receipt query. Host reads and command lookup use existing-only runtime policy. AgentRoam advertises externalGuideSupported only after a target-specific probe and forwards normal text sends or durable guide messages to that owner without local resume/send. Existing native history polling remains the event projection path.


## Observed source implementation result

- AgentRoam: six suites / 260 tests passed; native-runtime typecheck and isolated native/Webapp builds passed.
- ZCode: seven bridge/owner tests passed; full `pnpm typecheck` passed; `pnpm lint` passed with 70 warnings and zero errors; architecture check reports zero new violations; isolated Host component build passed.
- Native owner verification: controlled local model transport, original PID 3192 preserved, exactly one guide submission/queue/drain, matching native command receipt, same original session and final marker. Evidence is `.artifacts/zcode-desktop-guide-20261105/controlled-verification.json`.
- Activation remains separate: installed ZCode and active AgentRoam services were not replaced/restarted for this feature. Physical phone + installed Desktop acceptance and a complete installed-app release are not established by the component builds.
