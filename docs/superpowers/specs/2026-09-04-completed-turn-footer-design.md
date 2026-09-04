# Completed Turn Footer Design

## Goal

Make every completed assistant turn visibly terminal and useful after the live run has disappeared. The final assistant response shows a stable footer with completion state, total elapsed time when authoritative data exists, and the actions supported by the current client.

```text
✓ 已完成 · 总耗时 34 秒    [复制]
```

Desktop keeps the existing speech action next to copy. WebApp shows copy only because its `ttsSpeak()` implementation is a non-functional stub.

The duration is durable server-owned data. It survives a renderer refresh, broker or server restart, and access from another client connected to the same Customer Agent service. Browser storage and reconstructed renderer timestamps are not authoritative sources.

## User Experience

- Render the footer only below the final non-empty assistant text response of a completed turn.
- Show `已完成` for every such response, including legacy and externally created turns for which AgentRoam has no duration.
- Append `· 总耗时 <duration>` only when a finite, non-negative persisted duration is available.
- Round the display to whole seconds. Durations below one second display as `0 秒`; longer durations remain an integer number of seconds so the running and completed indicators use one unit.
- Keep the copy icon visible without requiring hover or keyboard focus.
- Keep the speech icon visible on Desktop and preserve its current start/stop behavior.
- Do not render a speech icon in WebApp.
- Reasoning summaries, tool rows, approval cards, widgets, compaction summaries, and intermediate assistant text do not receive a completed footer.
- The existing in-progress activity indicator remains unchanged. This feature supplies the durable terminal state after a successful turn finishes.

## Domain Contract

Extend display-only message metadata with one optional field:

```ts
interface MessagePresentation {
  // existing fields omitted
  completionDurationMs?: number;
}
```

Extend successful terminal events with the same optional measurement:

```ts
type AgentEvent =
  | { type: "done"; finalText: string; usage?: TokenUsage; durationMs?: number }
  // existing variants omitted
```

`durationMs` is elapsed wall-clock time from run admission to successful terminal completion. It is not model inference time, token generation time, or a value reconstructed from message timestamps. Producers must omit values that are not finite or are negative; consumers apply the same validation defensively.

The event field makes the footer appear immediately at completion. `MessagePresentation.completionDurationMs` is the durable history contract used after reload.

## Persistence Architecture

### Customer Agent Sessions

The server and Desktop Customer Agent hosts capture a monotonic run start at admission. When a successful `done` event is received, the host computes the elapsed milliseconds once, enriches the emitted event, and persists the final assistant message with `presentation.completionDurationMs`.

The existing `messages.presentation` JSON column stores this field, so no message-table migration is required. Failed, aborted, or protocol-incomplete runs do not receive successful completion metadata.

### Native Sessions

Codex, Claude Code, and OpenCode histories are owned by their native runtimes and cannot safely be modified. The native runtime broker therefore adds a compact durable table:

```sql
CREATE TABLE IF NOT EXISTS native_runtime_turn_completion (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  input TEXT NOT NULL,
  final_text TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS native_runtime_turn_completion_by_session
  ON native_runtime_turn_completion(session_id, completed_at ASC, run_id ASC);
```

On a successful `done`, the broker uses one terminal timestamp to:

1. calculate `duration_ms = completed_at - native_runtime_run.created_at`;
2. insert the compact completion record in the same SQLite transaction as terminalizing the run;
3. persist and broadcast the enriched `done` event.

The existing ten-minute cleanup continues to remove full run and event records, but never removes completion rows merely because replay retention expired. Hiding or deleting a native session removes its completion rows with the rest of AgentRoam-owned metadata.

## Native History Matching

When the broker applies a session detail, it projects completion rows onto native messages without changing native transcript files.

For each completion row in `(completed_at, run_id)` order, the projector identifies an unused turn segment consisting of:

1. a user message whose normalized visible content exactly equals the stored `input`;
2. messages up to, but not including, the next user message;
3. a final non-empty assistant text message whose content exactly equals `final_text`.

“Normalized visible content” means the content already produced by that runtime's existing history adapter. The projector compares those strings exactly and does not add case folding, whitespace trimming, punctuation changes, or any new provider-specific normalization.

The projector resolves all rows as one ordered subsequence of the history. Repeated identical turns are assigned in order only when that produces one unique mapping. If externally created identical turns make more than one mapping possible, all affected rows remain unmatched. The duration is attached only to a uniquely matched segment's final assistant text message. A row that cannot be matched exactly is ignored for presentation and remains available for a later read, covering native transcript flush delays without risking incorrect attribution.

No fuzzy content matching, nearest-timestamp matching, or renderer-generated timestamp matching is allowed. Native turns completed outside AgentRoam have no completion row and therefore display `已完成` without a duration.

## Data Flow

```text
run admitted
  -> authoritative start captured by host/broker
  -> progress, reasoning, tools, and text stream normally
  -> successful done
  -> duration calculated once
  -> enriched done delivered to renderer
  -> final visible assistant message receives completionDurationMs

history reload
  -> Customer Agent: duration read from messages.presentation
  -> native runtime: compact broker row strictly matched to native turn
  -> shared ChatView renders completed footer
```

For live native turns, the broker's enriched `done` event updates the already streamed final assistant message. If the native transcript has not flushed when the first history refresh occurs, the event projection continues to provide the live footer; subsequent history reads can apply the durable completion row once the exact turn is present.

## Rendering and Actions

Keep final-message classification in the shared `message-actions` policy. Expand its result so the view can render one footer rather than a loose action row:

- completion state and validated duration come from the final assistant message;
- copy is enabled for final assistant text on both clients;
- speech is enabled only when the shell is Desktop and the existing TTS bridge is available;
- user-message actions and goal markers retain their existing behavior and are not labeled `已完成`.

The completed footer is always opaque. Other action rows may keep existing hover behavior. Use the existing icon system and compact message typography; the status label and controls must not shift the message card width when state changes.

## Error and Compatibility Behavior

- Legacy messages and external native turns: render `已完成` and copy, omit duration.
- Missing or invalid duration: omit only the duration; keep content, completion label, and actions.
- Persistence failure: finish the visible answer and report through existing diagnostics; do not fabricate or cache a durable duration in the browser.
- Native strict-match failure: leave the row unapplied and render the ordinary duration-less completed footer.
- Duplicate or replayed `done` event: `run_id` makes the native completion write idempotent, and the renderer updates rather than duplicates the footer.
- Failed or aborted turn: preserve existing error/aborted UI and do not label it successfully completed.
- Existing stored `presentation` JSON without the new field remains valid.

## Testing

Focused tests must cover:

- final assistant text gets a completion footer while intermediate assistant, reasoning, tool, widget, approval, and compaction rows do not;
- copy is visible without hover on Desktop and WebApp;
- speech remains available on Desktop and is absent in WebApp;
- duration formatting at `0`, sub-second, minute, and invalid-value boundaries;
- live `done.durationMs` updates the correct streamed assistant response;
- Customer Agent message persistence survives store reconstruction;
- native completion rows survive broker reconstruction and ten-minute event pruning;
- strict native matching handles repeated identical AgentRoam turns in order when the mapping is unique;
- ambiguous duplicate native turns omit duration rather than attaching it to a possibly wrong response;
- unmatched or externally created native turns never inherit another turn's duration;
- failed and aborted runs do not persist successful completion metadata;
- current message action, history reconciliation, queued-message, and native event replay tests remain green.

Run the focused Core, broker, renderer, server, and WebApp test suites, affected TypeScript checks, `git diff --check`, and the WebApp build. Visual verification must use the project-required `ego-browser` workflow at desktop and mobile widths, checking both a newly completed turn and the same turn after reload.

## Non-Goals

- Implementing WebApp text-to-speech.
- Changing Desktop speech synthesis behavior or automatic speech settings.
- Reconstructing historical durations that AgentRoam never recorded.
- Retaining full native run events indefinitely.
- Changing queue dispatch, steering, tool rendering, reasoning presentation, or the current in-progress activity indicator.
- Writing completion metadata into Codex, Claude Code, or OpenCode transcript files.
