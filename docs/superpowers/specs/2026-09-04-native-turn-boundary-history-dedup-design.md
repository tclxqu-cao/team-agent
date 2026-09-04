# Native Turn-Boundary History Deduplication Design

## Goal

Prevent a completed native Agent turn from appearing twice when the WebApp replaces its live event projection with persisted native history.

The history contract must not split the latest turn between pages. A page size such as `50` is a soft target: when the nominal page boundary falls inside a turn, the page expands backward to the user message that started that turn. The renderer can then replace the complete live turn with the complete persisted turn instead of trying to reconcile two partial representations.

## Confirmed Failure

The affected Codex thread is `01a06c41-e089-7020-87a0-7e55a984118b`. Run `8da5b6d6-f7ea-4440-afb1-fc9c83e462b8` started from user input `2` at 21:33:17 and completed at 21:34:59.

The run input and final response were 54 conversational history items apart. The existing 50-item latest page therefore contained the persisted final response but excluded the run's user input. The WebApp already held the complete live event projection. Without the user boundary as an overlap anchor, the live and persisted forms could both survive the terminal refresh.

The source data is not duplicated:

- the Codex rollout contains one `final_answer` item;
- the broker retained one ordered text stream and one `done` event;
- the current session detail contains one matching assistant response.

This is a history projection and reconciliation defect, not a repeated model run or duplicate persistence write.

## Chosen Design

### Turn-Boundary Pagination

`paginateSessionHistory()` continues to paginate the ordered user and assistant conversation while attaching tool-result rows to their owning assistant message.

For each page:

1. Resolve the exclusive page end from the existing cursor, or use the end of the conversation for the latest page.
2. Calculate the nominal start as `max(0, end - limit)`.
3. If the nominal start is inside a turn, move it backward to the nearest preceding user message.
4. Return every conversational message from that adjusted start to the original end, plus the tool-result rows referenced by assistant tool calls.
5. Encode the adjusted start in `nextCursor` so the preceding page ends exactly where this page begins.

The requested limit remains a minimum target rather than a hard maximum. A single long turn may make a page larger than the requested limit. Preserving one coherent turn is more important than enforcing an arbitrary message count, and the existing native broker already reads and reconciles the complete transcript before pagination.

If no preceding user message exists, the page starts at the beginning of history. This preserves legacy assistant-only transcripts without inventing a turn boundary.

### Broker Ordering

The native runtime broker keeps its existing ordering:

```text
read complete native transcript
  -> reconcile retained run events against native messages
  -> paginate the reconciled result at turn boundaries
  -> return the page and adjusted cursor
```

Projection must never be applied independently to each page. Doing so can synthesize a second `__native_run:<runId>` input or assistant projection when the original input is on an older page.

### Renderer Reconciliation

`mergeRefreshedSessionHistory()` remains responsible for preserving already loaded older history and queued messages while replacing the latest page.

With a complete turn in the refreshed page, the persisted user input is the stable alignment anchor. The renderer replaces the matching live turn tail with the refreshed turn, retaining prior pages before the aligned boundary and durable queued messages after it. It does not deduplicate arbitrary assistant text globally.

Native SSE events continue to use `_nativeRunId + _nativeSequence` for replay protection. This event identity prevents a transport replay from being applied twice, while turn-boundary history reconciliation handles the separate live-versus-persisted representation problem.

## Cursor And Compatibility Behavior

- Keep the existing opaque `history.v1.<offset>` cursor format.
- Interpret the offset against user and assistant conversational messages, as today.
- Emit the adjusted turn-boundary start in `nextCursor`; older clients can consume it without a protocol change.
- Preserve `hasMore`, `totalItems`, and tool-result attachment semantics.
- Preserve legacy histories that start with assistant messages.
- Do not change workspace-session pagination; this design applies only to messages inside one session.

## Error Handling

- Invalid cursors retain the existing fallback to the supplied page end.
- A turn with no tool result still returns its assistant tool call unchanged.
- Orphan tool-result rows remain excluded unless their tool call is in the returned page.
- Repeated user text is not treated as globally unique. Renderer alignment prefers the location nearest the expected latest-page boundary and replaces only one ordered turn range.
- If no safe history overlap exists, keep the existing fallback replacement behavior; never remove messages solely because their text matches.

## Testing

Focused coverage must include:

- a 54-item turn requested with `limit: 50` starts at its user message and returns the complete turn;
- `nextCursor` points to that adjusted start, and loading the older page produces no overlap or gap;
- tool results referenced by the expanded page remain attached to their assistant tool calls;
- an assistant-only legacy prefix still paginates from index zero when no user boundary exists;
- a retained native run reconciles against the complete transcript before turn-boundary pagination and produces one final response;
- a WebApp live turn and refreshed persisted turn with different tool-message grouping merge into one final response;
- repeated identical user or assistant text in separate turns is preserved;
- existing standard-size pagination, queued-message preservation, and native event replay tests remain green.

Run the focused Core pagination, native broker, renderer history, Server route, and WebApp gateway suites, followed by affected TypeScript checks and `git diff --check`.

## Non-Goals

- Content-based global deduplication.
- Changing Codex, Claude Code, or OpenCode transcript files.
- Changing the message-history cursor version.
- Enforcing the requested page size as a hard response cap.
- Changing queue dispatch, terminal event handling, tool rendering, or workspace-session pagination.
- Repairing duplicate rows in storage, because the confirmed session has no duplicate stored row.
