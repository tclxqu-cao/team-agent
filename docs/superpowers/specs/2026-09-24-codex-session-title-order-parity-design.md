# Codex Session Title and Order Parity Design

## Goal

Make AgentRoam Webapp show the same Codex session titles and native session order as Codex Desktop, including after another Codex process renames or activates a session.

## Current Failure

AgentRoam preserves the order returned by its runtime adapter, but the adapter requests `thread/list` with `sortKey: "updated_at"`. Codex Desktop orders the same threads by `recency_at desc`, so preserving the adapter response cannot produce desktop parity.

The adapter also uses one long-lived `codex app-server --stdio` process for both execution and discovery. `refresh=1` clears AgentRoam caches, but it queries that same process. A title changed by Codex Desktop can therefore remain stale in AgentRoam even though a newly started app-server returns the current `thread.name`.

## Chosen Design

### Separate Execution and Discovery Connections

`CodexRuntimeAdapter` will own two app-server clients:

- The execution client remains responsible for session history, resume, turns, approvals, notifications, and all active-run state.
- The discovery client is responsible only for `project/list` and `thread/list` requests used to build workspace and session lists.

An explicit first-page refresh restarts only the discovery client before it reads projects or threads. The execution client is never restarted by list refreshes, so refreshing the sidebar cannot interrupt an active Codex turn.

Legacy full discovery also refreshes the discovery connection before enumerating threads. Both clients are disposed when the adapter is disposed. Process-occupancy checks exclude both AgentRoam-owned client PIDs.

### Native Title Contract

Session summaries keep the existing title mapping:

```ts
title = (thread.name || thread.preview || "Codex session").trim()
```

The refreshed discovery connection makes `thread.name` current across Codex processes. AgentRoam will not read Codex private SQLite files or introduce a second title database.

### Native Order Contract

Every Codex `thread/list` request used for discovery will send:

```ts
{
  sortKey: "recency_at",
  sortDirection: "desc",
}
```

The workspace index and renderer continue preserving the returned Codex order. The renderer's optional "running sessions first" partition will not reorder Codex sessions, because that would violate desktop parity. Other runtimes retain the existing behavior.

Pinned sessions remain in AgentRoam's explicit pinned section. Pinning is a user-selected AgentRoam override rather than part of the native Codex list order.

## Data Flow

1. Webapp requests a Codex workspace session page, optionally with `refresh=1`.
2. AgentRoam's workspace index clears its own first-page cache when refresh is requested.
3. `CodexRuntimeAdapter` restarts only the discovery app-server for an explicit first-page refresh.
4. The discovery client requests `thread/list` with `recency_at desc` and the relevant `projectId` or exact `cwd` filter.
5. The adapter maps each thread using current `thread.name`, falling back to `preview`, and preserves response order.
6. The renderer displays that order without applying the running-first partition for Codex.

Cursor pages do not restart the discovery client. This keeps one app-server snapshot and cursor sequence for the pagination walk.

## Error Handling

- Discovery restart or listing errors follow the existing workspace-index stale-cache behavior: return the prior cached page with `stale: true` when available, otherwise surface the normalized runtime error.
- A discovery failure does not stop or dispose the execution connection.
- Concurrent refresh requests share one discovery restart promise so they do not repeatedly stop and spawn the discovery process.
- The legacy exact-root fallback remains unchanged except for using the discovery client and native recency sort.

## Testing

Focused native-runtime tests will verify:

- discovery requests use `recency_at desc` for full, project, legacy-root, and direct-path listings;
- explicit refresh restarts the discovery client but never the execution client;
- cursor continuation does not restart discovery;
- a refreshed discovery response replaces a stale preview with the current native name;
- adapter disposal closes both distinct clients and closes a shared injected client only once;
- both AgentRoam-owned app-server PIDs are excluded from occupancy detection where applicable.

Focused renderer tests will verify that running-first remains effective for non-Codex runtimes but preserves native source order for Codex.

Verification will run under Node 22 and include the affected native-runtime and renderer unit tests, TypeScript builds for changed packages, and `git diff --check`. Runtime acceptance will compare a refreshed Webapp response and rendered sidebar against Codex Desktop without restarting the execution connection or interrupting active sessions.

## Alternatives Rejected

### Restart the Existing App-Server on Refresh

This would refresh names, but it also owns active turns, approval requests, and notification streams. Restarting it from a sidebar refresh risks interrupting live work.

### Read Codex SQLite Directly

This can observe current titles and recency values, but it couples AgentRoam to a private database schema and bypasses the supported app-server protocol.

### Change Only `updated_at` to `recency_at`

This fixes ordering but leaves cross-process title updates stale in the long-lived app-server, so it does not solve the reported partial mismatch.
