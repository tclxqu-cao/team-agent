# Codex Session Consistency And Streaming Design

## Goal

Codex session history and live execution must form one ordered timeline across
three entry paths: a session created in WebApp, an externally running Desktop
session viewed in WebApp, and a fork created after an occupied-session error.
The timeline must not duplicate, lose, or reorder user messages, commentary,
reasoning, tool calls, tool results, or the final answer. These guarantees must
preserve the core-first and lazy-result performance model.

## Authoritative Data Boundaries

The Codex adapter owns persisted history and rollout order. Its progressive
responses have two authoritative delivery modes:

- `core` contains only visible user messages, final answers, and one trace
  locator per turn;
- `trace` contains the ordered reasoning, commentary, and tool metadata for one
  requested turn, with large tool results represented by lazy locators.

The Broker retained-run projection is a recovery source for `legacy-full`
history only. It must never be merged into adapter-native `core` or `trace`
responses. Those responses already reconcile the native summary, hydrated
turn, and rollout commentary. Merging the projection again duplicates tool
calls and can reintroduce complete tool-result bodies into the first page.

SSE is authoritative for Broker events not already consumed by the browser. A
streamed event is identified by `(runId, sequence)`. The browser gateway keeps
a monotonic consumed-event cursor for each run and the renderer ignores an
already consumed event key. A new run may restart its sequence at one, so
sequence comparison is never global across runs.

`snapshotRevision` is not automatically a consumed-event cursor. A progressive
`core` or `trace` response contains no Broker events, so advancing to its
snapshot revision would skip events the page never rendered. When a running
progressive session is first restored without an in-memory consumed cursor,
WebApp subscribes from sequence zero of the current run and reconciles the
replay with persisted trace items by stable ID. A legacy response that actually
contains the projected events may continue after its snapshot cursor.

Within one turn, persisted and live execution items reconcile by native
identity:

- commentary: `turnId + agent itemId`;
- reasoning: `turnId + reasoning itemId + sectionIndex`;
- tool call and result: `turnId + toolCallId`;
- transport delivery: `runId + sequence`.

Text equality is not an identity. Different turns may legitimately contain
identical text, commands, or results.

## Ordering Contract

The adapter emits trace messages in rollout item order. Live messages retain
SSE sequence order. Reconciliation overlays newer content and result metadata
onto a matching item without moving that item.

When a live trace existed before a persisted trace refresh, matching native
items are ordering anchors. History-only items are inserted in their persisted
order around those anchors, while live-only items keep their live order. This
prevents an early live commentary item from moving behind a later tool merely
because the first snapshot did not contain that commentary yet.

When there are no shared anchors, the persisted trace is treated as the prefix
and the live trace as the suffix. This is the refresh/reconnect case where the
consumed-event cursor deliberately excludes already rendered SSE events.

The final answer is not an execution item. Running core history accepts only an
explicit `final_answer`; an unphased agent message is accepted as a legacy final
answer only after the turn is completed.

## Pagination And First-Paint Performance

Opening a Codex session requests `view=core` with the latest page limit. It must
not hydrate every turn, request any historical trace, include tool calls, or
include tool-result bodies. Older core pages use the same ordinal cursor space
and cannot receive the current retained run.

Opening an execution trace requests exactly one `turnId` at the current
revision. Trace metadata bounds reasoning and tool arguments, and tool results
remain lazy until their individual row is expanded. An untouched historical
turn performs no trace request.

Regression tests use a 256 KiB retained tool result and require progressive
`core` and `trace` Broker responses to contain no projected events or tool body
and remain below 16 KiB for the synthetic fixture. Production acceptance also
records response bytes, duplicate identities, and request counts instead of
using visual inspection alone.

## User Flows

### WebApp-Created Session

The native run is admitted before WebApp opens SSE. The admission response
provides the pre-run snapshot revision, and SSE replays every later event. The
optimistic user message remains one item; commentary, reasoning, tools, and the
answer appear as they arrive. A core refresh overlays persisted data without
creating a second live trace.

### Desktop Session Viewed In WebApp

The selected native session is observed for transcript revision changes even
when WebApp does not own its writer. Each change refreshes the lightweight core
tail. The latest running turn auto-loads only its trace and refreshes it with a
bounded interval, so Desktop progress becomes visible without hydrating older
turns or loading tool bodies.

### Fork After Occupancy

Fork is non-idempotent and is called exactly once. The returned summary is kept
as a pending discovery item, selected immediately, and the saved payload starts
one normal native run in that fork. From admission onward it uses the same SSE,
cursor, live trace, refresh, and reconciliation path as a WebApp-created
session. Retrying a failed send reuses the same fork and never creates another
copy.

## Recovery And Errors

- A stale trace revision refreshes core once and retries only that trace.
- A late core response cannot overwrite a newer selected-session generation.
- A progressive snapshot never advances the browser's consumed-event cursor.
- Accepted SSE events advance that cursor monotonically, and reconnect resumes
  after the greatest dispatched sequence for that run.
- A cursor from another run replays the new run from sequence zero.
- A trace or tool-result failure is local to that row and remains retryable.
- Network recovery never retries the non-idempotent fork request.

## Verification

Focused tests must cover:

- `core` and `trace` exclude retained projection events and large results;
- `legacy-full` still restores a retained active run;
- same-run consumed-event cursors are monotonic and new-run cursors may reset;
- repeated or delayed SSE events render once and preserve sequence order;
- snapshot plus SSE reconciliation preserves commentary/reasoning/tool order;
- a persisted call/result overlays the live tool rather than appending a copy;
- initial core load, old-page prepend, refresh, and stale trace retry preserve
  message boundaries and lazy loading;
- WebApp create, external Desktop observation, and fork reuse the intended
  streaming path.

After Node 22 unit and type checks, build WebApp and Server, restart the managed
`:3000` instance, and use ego-browser for real acceptance. The acceptance must
exercise a new session, a refresh during execution, an externally running
Desktop session, and a forked session. It must inspect network requests and DOM
identity/order as well as visible output.

## Non-Goals

- Global text-based deduplication.
- Loading all trace metadata or tool results on first paint.
- Replacing the Broker with a new event-store architecture.
- Changing Claude Code, OpenCode, or Customer Agent history contracts.
