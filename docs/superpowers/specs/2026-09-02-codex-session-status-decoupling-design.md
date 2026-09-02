# Codex Session Status Decoupling Design

## Goal

Keep Codex writer-lock ownership authoritative for resume safety while ensuring an externally owned but idle conversation is not presented as actively generating.

## Current Failure

`CodexRuntimeAdapter.toSummary()` derives `status` from `occupancy`. Any externally open rollout therefore becomes both `occupancy: "owned-externally"` and `status: "running"`, even when Codex reports `thread.status.type: "idle"`.

`NativeRuntimeBrokerState.applySummary()` repeats the same coupling by forcing every non-available occupancy to `running`. The renderer correctly treats unified `status: "running"` as an active turn, so restored reasoning summaries remain marked `生成中` indefinitely.

## Domain Model

`occupancy` and `status` represent independent facts:

- `occupancy` answers who may control or resume the thread.
- `status` answers whether work is currently executing.

The valid state `occupancy: "owned-externally"`, `status: "idle"` means the original Codex client still owns the writer lock but has no active turn. The conversation remains read-only and can be continued through an explicit fork, while the UI shows no activity indicator.

## Runtime Adapter

`CodexRuntimeAdapter` maps native thread state into the unified session contract:

- `active` maps to `running`.
- `systemError` maps to `failed`.
- `idle`, `notLoaded`, missing, and unknown non-active values map to `idle`.
- A thread owned by Customer Agent's active adapter queue remains `running` during the short window before Codex reports `active`.

Rollout-file ownership continues to determine only `occupancy` and `canResume`. Codex retains strict writer-lock handling with no mtime-based auto-unlock.

## Broker Projection

`NativeRuntimeBrokerState.applySummary()` preserves the adapter's status when no broker run is active. When the broker owns an active run, it projects `status: "running"`, `occupancy: "owned-by-customer-agent"`, and the active controller.

This keeps the broker authoritative for runs admitted through Customer Agent without overwriting native execution state merely because another client owns the writer lock.

## Renderer

The shared renderer continues to consume `UnifiedSessionSummary.status` and `occupancy` without Codex-specific exceptions:

- `status: "running"` controls live activity and reasoning-summary streaming presentation.
- `occupancy: "owned-externally"` controls the read-only notice, send protection, and `以副本继续` action.

No UI-only suppression is added. Correctness belongs in the runtime and broker domain projections.

## Testing

Focused tests cover:

- Native `idle` plus external occupancy remains unified `idle` and read-only.
- Native `active` plus external occupancy remains unified `running` and read-only.
- An active Customer Agent broker run overrides the adapter status to `running` and owned by Customer Agent.
- A completed external conversation no longer rehydrates the renderer as a running session or marks restored reasoning summaries as `生成中`.
- Existing strict Codex writer-lock and occupied-session fork tests remain green.

Run the Codex adapter, native broker, and renderer-focused Vitest suites, followed by affected TypeScript checks. Validate the live `:3000` session response after release: the target conversation must return `status: "idle"`, `occupancy: "owned-externally"`, while the composer remains read-only.

## Non-Goals

- Releasing or stealing the original Codex writer lock.
- Re-enabling the 120-second Codex mtime takeover heuristic.
- Automatically forking or resuming an occupied conversation.
- Changing Claude Code occupancy behavior.
- Adding renderer heuristics that infer execution from lock ownership.
