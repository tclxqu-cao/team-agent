# Codex Complete Session Pagination Design

## Goal

AgentRoam must expose every Codex session available from the local Codex runtime. Each workspace loads 20 sessions initially and loads another 20 when the user scrolls near the bottom, continuing until no cursor remains.

## Current Failure

Codex sessions created after native projects were introduced carry a `projectId`, while older sessions may only carry a `cwd`. The current adapter queries by `projectId` and falls back to `cwd` only when the project query returns no rows. A workspace containing both forms therefore returns only the newer subset.

The workspace sidebar also has no entry for sessions that cannot be associated with any native or imported workspace, so those sessions are not reachable after the workspace-index redesign.

## Design

### Workspace Sessions

For a native Codex workspace, load the complete candidate set from both sources:

- sessions whose `projectId` equals the workspace ID;
- legacy sessions without a project assignment whose `cwd` belongs to one of the workspace roots.

Merge by native thread ID, sort by update time descending, then paginate the merged result with an opaque cursor. A session returned by both sources appears once.

Path association must use normalized path-boundary matching so a workspace such as `/repo/app` does not claim `/repo/application`. A legacy session in a nested working directory belongs to the most specific matching workspace root.

### Recent Workspace

Codex always exposes a synthetic `最近` workspace before native workspaces, including when it is empty. It contains only sessions that cannot be associated with any native or imported workspace, preventing duplicates between `最近` and directory groups.

The synthetic workspace has no filesystem root. It supports reading, resuming, deleting or hiding, status display, and pagination, but does not support creating a new session.

### Pagination

The renderer requests 20 sessions per page. The first page is shown immediately. When the workspace session container is within the existing near-bottom threshold and `nextCursor` is present, the next 20 are fetched and reconciled by unified session ID. Loading continues until `nextCursor` is null; 20 is a page size, not a total limit.

The pagination cursor belongs to the merged and classified snapshot rather than either individual Codex query. This prevents skipped or duplicated rows when project-ID and legacy-path results interleave by update time.

### Refresh And Errors

A first-page refresh replaces the current snapshot while preserving cached rows if the runtime request fails. Later-page failures leave already loaded sessions visible and keep the cursor available for retry. Project-change notifications invalidate the Codex workspace and session snapshots so renamed, reordered, newly assigned, or newly unassigned sessions are reclassified.

## Validation

Automated coverage will verify:

- five project-ID sessions plus two legacy-path sessions produce seven unique rows;
- a nested legacy `cwd` is assigned to the most specific workspace without sibling-prefix false matches;
- `最近` contains only unmatched sessions and never duplicates directory sessions;
- 45 sessions page as 20, 20, and 5 with stable ordering and no omissions;
- the renderer requests a 20-row first page and loads subsequent pages on scroll;
- the synthetic workspace does not offer a create action while normal workspaces still do.

Focused runtime and renderer tests, affected TypeScript checks, and `git diff --check` form the delivery gate.
