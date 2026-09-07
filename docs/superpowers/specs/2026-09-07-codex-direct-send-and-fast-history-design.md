# Codex Direct Send And Fast History Design

## Goal

AgentRoam Web should let the user send to an idle Codex session even when process observation reports `owned-externally`. The native App Server writer check remains authoritative: only a real `SESSION_OCCUPIED` failure activates fork recovery, and the recovery fork automatically sends the preserved message exactly once.

Opening a long Codex session should show its user messages and final answers before large reasoning and tool payloads finish loading. Collapsed tool bodies must not be transferred to the browser until the user expands the corresponding tool row.

The shared renderer keeps Electron and Web behavior aligned. The performance optimization is Codex-specific at the adapter boundary and must not change Claude Code, OpenCode, or Customer Agent history semantics.

## Superseded Behavior

This design replaces two parts of `2026-09-01-codex-occupied-session-fork-design.md`:

- `owned-externally` is advisory for sending and no longer disables the composer or exposes a proactive fork action.
- A fork created after a failed send automatically submits the preserved payload; it does not merely restore editable text.

It does not permit stealing or force-releasing a writer lock. It also does not change archive, delete, or other lifecycle operations, which may continue to reject externally owned sessions before attempting mutation.

## Send And Recovery Flow

### Advisory Occupancy

For Codex sessions, `occupancy: owned-externally` reports that another Codex process has the rollout open. It is useful status but is not proof that `thread/resume` will fail. The composer remains enabled when compatibility and runtime readiness checks pass.

Sending keeps the current backend behavior:

1. Preserve the complete pending send payload before clearing the composer. The payload contains text, images, selected agents, model, reasoning effort, permission mode, and goal metadata used by the original attempt.
2. Submit the original session ID through the normal run path.
3. Let `CodexRuntimeAdapter.run()` call `thread/resume`; do not preflight-reject based on `owned-externally`.
4. If the App Server accepts the resume, continue the original session and discard the recovery payload.
5. If the run terminates with the structured code `SESSION_OCCUPIED`, remove only the failed optimistic message, retain the recovery payload, and show `以副本继续`.

`SESSION_ALREADY_RUNNING` remains the existing queue/reconciliation path and must never offer a fork.

### Fork And Automatic Send

The recovery action is a guarded state machine keyed by source session ID:

- `ready`: one failed payload is available for recovery.
- `forking`: one non-idempotent `forkSession` request is in flight; the button is disabled.
- `activating`: the returned fork summary is inserted and selected through the existing pending-discovery protection; history loading starts in parallel and does not gate sending.
- `sending`: the preserved payload is submitted to the fork once through the normal send path.
- `complete`: the payload is cleared only after the fork accepts the run.
- `failed-before-fork`: the source remains selected, the payload stays recoverable, and retry calls `forkSession` again.
- `failed-after-fork`: the returned fork remains selected, the payload stays recoverable, and `重新发送` retries against that fork ID without calling `forkSession` again.

The transition from `activating` to `sending` occurs as soon as the fork summary is registered. It must use the returned fork ID rather than wait for history or rely on a possibly stale selected-session React closure. A per-recovery token prevents effects, rerenders, Strict Mode, reconnects, and history refreshes from submitting the same payload twice.

If fork creation fails, retrying may call `forkSession` again because no fork ID was returned. If fork creation succeeds but activation, history loading, or sending fails, retry must reuse that same fork and must not create another copy.

## Progressive Codex History

### Core Page

The initial Codex history request uses the existing native paging summary as the core page. It returns, in rollout order:

- user messages;
- final agent messages;
- history cursors, revision, and turn boundaries needed for pagination and reconciliation.

It does not wait for full-turn hydration and does not include reasoning bodies, tool arguments, or tool results. The renderer commits this page immediately, so the conversation becomes readable before execution details arrive.

### Trace Enrichment

After the core page is visible, the renderer requests trace metadata for the same session, history window, and revision. The Codex adapter hydrates only the turns intersecting that window and returns lightweight execution rows:

- stable turn and item locators;
- reasoning summaries needed by the collapsed row, capped at 4 KiB of UTF-8 text per item;
- tool name, status, and an argument preview capped at 2 KiB of UTF-8 JSON per item;
- tool-result availability and byte size, without the result body;
- ordering metadata for merging the trace between the existing user and final-answer messages.

The renderer merges enrichment only when session ID, window revision, and request generation still match. Switching sessions or receiving a newer history revision discards stale enrichment. Failure leaves the already visible core messages intact and exposes a retry for execution details without turning the whole session into `Load failed`.

### Tool Body On Demand

Every tool result in trace enrichment is represented by a locator, byte size, and `bodyLoaded: false`; its body is omitted regardless of size. Expanding that tool row requests the full body by session, turn, item, and current revision. The adapter may satisfy the request from its hydrated-turn cache; otherwise it hydrates the containing turn and returns only the selected body.

The body endpoint is read-only, validates that the locator belongs to the requested session, and rejects a stale revision rather than returning mismatched content. The renderer deduplicates concurrent expansion requests for the same locator and caches successful bodies for the lifetime of the loaded session revision.

Collapsed rows never transfer or mount a result body in the browser. Once fetched, the selected full body is mounted only while that tool row is expanded.

### Compatibility Fallback

Native paging and progressive trace loading stay behind the Codex adapter capability boundary. If the running Codex version does not support the required paging methods or returns an incompatible schema, the adapter keeps the existing `legacy-full` fallback so history remains readable, though slower. No native cursor or item locator is persisted across App Server restarts or Codex upgrades.

## Error Handling

- Advisory occupancy never produces a local error and never disables send.
- Only structured `SESSION_OCCUPIED` creates recovery state; raw English protocol messages are not parsed in the renderer.
- The failed send payload survives fork, activation, history, network, and automatic-send failures until the new run is accepted or the user deliberately replaces it.
- Successful original-session send clears any stale recovery state for that source.
- A session switch hides recovery controls for other sessions without deleting their pending payload.
- Core history failure uses the existing bounded retry and manual reload behavior.
- Trace or tool-body failure cannot remove already rendered user/final messages.

## Testing

Focused automated coverage must prove:

- `owned-externally` Codex sessions keep the composer enabled and call the original run path.
- Accepted `thread/resume` never creates a fork.
- Actual `SESSION_OCCUPIED` preserves the complete failed payload and is the only send error that exposes `以副本继续`.
- One click creates one fork and automatically sends the payload once, including under duplicate render/effect execution.
- A post-fork send retry reuses the created fork; a fork failure remains retryable without changing selection.
- `SESSION_ALREADY_RUNNING` continues to queue and never enters fork recovery.
- The initial native history page uses summary data without full-turn hydration and contains ordered user/final messages.
- Trace enrichment is revision-scoped and stale responses are discarded.
- all tool-result bodies are absent from core and trace responses, load on first expansion, deduplicate concurrent requests, and stay cached for the current revision.
- unsupported or incompatible Codex pagination still falls back to readable legacy history.

Run the affected renderer, Codex adapter, broker/service, server route, and Web gateway tests under Node 22, followed by Desktop/WebApp type checks and `git diff --check`. Browser acceptance should use the real externally held session and a known large session: direct send must be attempted before recovery appears, fork recovery must auto-send once, and user/final messages must become visible before trace enrichment completes.

## Non-Goals

- Releasing, stealing, or bypassing Codex Desktop's writer lock.
- Automatically forking before a real failed send.
- Retrying the non-idempotent fork request after a fork ID has been returned.
- Virtualizing the entire chat timeline in this change.
- Changing lifecycle mutation locks or non-Codex runtime history contracts.
