# ZCode Mid-turn Steering Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Enable ZCode's queued-message guide action through its existing stdio V4 command endpoint.

**Architecture:** The ZCode protocol client owns command identities, ACK validation and ambiguous-response reconciliation. The native adapter exposes optional steering, the broker passes durable message IDs and consumes a queued item only after native admission. The renderer enables its existing guide button.

**Tech Stack:** TypeScript, NDJSON RPC, Vitest, React.

## Global Constraints

- Preserve the earlier question-card fixes and unrelated concurrent workspace edits.
- Do not modify project docs or publish/restart the running service.
- Native command ACK confirms input admission, not model completion; validate the native input identity and preserve the broker item on explicit failure.
- Guide uses `sendText` with `requestedDelivery: "guide"`; it does not stop the active turn or submit the broker queue ID as a native queue ID.
- Reuse a stable V4 command ID for the same durable message and query the original native command on ambiguous replies.

### Task 1: ZCode native steering

**Files:** Create `packages/native-runtime/src/agent-runtime/zcode-steering.ts`; modify `zcode-client.ts`, `stdio-native-runtime-adapter.ts`.

**Interfaces:** Consume `NativeRpcConnection`; expose `steer(sessionId: string, input: string, messageId?: string): Promise<boolean>` only for supporting clients.

- [x] Implement native envelope creation and pending-operation coalescing. Submit:

```ts
{ commandId, clientId: "agentroam", sessionId, type: "sendText", payload: { text: input, requestedDelivery: "guide" }, issuedAt }
```

- [x] Accept only matching ACK and `result.type === "inputAccepted"` with matching inputId and supported delivery; native queue ACK is valid for guide admission. Query `v4/commands/query` with the same session/command key after a transport timeout. Repeated broker retries reuse the original command identity.
- [x] Restrict submission to a locally owned active run; abort/dispose must not replay sends.
- [x] Add fixture tests for active/idle/external ownership, real queue-shaped ACK, duplicate replies, rejection, malformed ACK, timeout reconciliation and concurrent/repeated calls.

### Task 2: Durable broker and UI wiring

**Files:** Modify `native-runtime-broker.ts`, `native-runtime-broker.test.ts`, `runtime-capabilities.ts`, `runtime-capabilities.test.ts`.

- [x] Forward the durable queue message ID for ZCode, retaining the same protocol command identity on retries.
- [x] Complete the durable message receipt after native admission and preserve it on rejection/error. Verify concurrent requests do not submit multiple native commands.
- [x] Enable ZCode's existing guide action; leave unsupported Qoder/WorkBuddy actions disabled.

## Final Unit Test Verification

- [x] Run affected native steering, ZCode, broker, unified service, renderer capabilities, queued steering and existing question-card regression suites using `bunx vitest run` with explicit file paths.
- [x] Run `bunx tsc --noEmit -p packages/native-runtime/tsconfig.json`, an isolated native-runtime bundle build and `git diff --check`.
- [x] Use an isolated native fixture to verify actual V4 admission/consumption without interacting with the user's live sessions; report any inference validation limit.

## Verified Result

Native ZCode 3.17.2 isolated inference: guide admitted once, drained once, final marker matched, completed in 21.751 seconds. Evidence: `.artifacts/zcode-guide-20261105-1hat_8ay/verification.json`. Native runtime typecheck and isolated bundle build passed. No running service was restarted or published.
