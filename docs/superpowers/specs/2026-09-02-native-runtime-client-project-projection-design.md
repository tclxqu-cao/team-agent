# Native Runtime Client-Scoped Project Projection

## Problem

All Customer Agent surfaces share one native runtime broker at
`~/.agentroam/native-runtime/native-runtime.sock`. The first process that becomes
the broker host currently supplies its own project store to
`UnifiedSessionService`. Native session summaries therefore receive project IDs
from that process's database.

When a temporary Web server becomes the broker host with an empty or isolated
`AGENT_DATA_DIR`, the production Web server can still discover native sessions,
but none match its project IDs. Project-scoped session requests return an empty
list even though the unfiltered native session list is healthy.

## Decision

The broker owns runtime-global state only: native process discovery, runs,
approvals, locks, event retention, and controller handoff. It does not own a
client's project catalog and must return native summaries without a
`projectId` derived from the broker host.

Each client projects native sessions onto its own project catalog:

- Desktop continues to use its outer `UnifiedSessionService`, which associates
  broker summaries by `cwd` using the Desktop project store.
- Web extends `NativeRuntimeService` with its local project loader. Its list,
  refresh, detail, create, and fork results are associated by `cwd` before they
  are returned to routes.
- A project-scoped Web list first obtains the unfiltered broker list, applies
  local project association, and then filters by the caller's `projectId`.

Local project association is authoritative. Any project ID supplied by an old
or independently hosted broker is cleared before matching so project IDs never
leak across client databases.

## Data Flow

1. A Web or Desktop client requests native sessions from the shared broker.
2. The broker discovers Codex and Claude Code sessions and returns runtime
   metadata including `cwd`, without client project ownership.
3. The requesting client loads its own projects and selects the most specific
   project path containing the session `cwd`.
4. The client attaches that local `projectId` and applies any requested project
   filter.

Pending newly created sessions follow the same projection before being cached
or returned, so the existing empty-thread visibility workaround remains intact.

## Error Handling

- Native discovery failures retain the existing route fallback to Customer
  Agent sessions.
- Project loading failures propagate through native discovery and use the same
  fallback; they must not return sessions associated with stale foreign IDs.
- Sessions whose `cwd` matches no local project remain unassociated and appear
  only in unfiltered or other-local views.

## Tests

- Broker host discovery remains project-neutral even when a project loader is
  supplied by a host process.
- Web maps an unscoped broker summary into its own project and returns it from a
  project-scoped list.
- Web ignores a foreign project ID and remaps by `cwd` to its local project ID.
- Web returns no native sessions for a nonmatching project.
- Existing pending-create, fork, history, occupancy, approval, and handoff tests
  continue to pass.

## Runtime Recovery

After tests and production build pass, stop the temporary `:3001` process that
owns the shared socket and restart the launchd-managed `:3000` service. Verify:

- `/api/sessions?projectId=<customer-agent-id>&refresh=1` returns the expected
  native sessions;
- the current Codex session appears under the registered `customer-agent`
  project;
- runtime health remains available for Codex and Claude Code.
