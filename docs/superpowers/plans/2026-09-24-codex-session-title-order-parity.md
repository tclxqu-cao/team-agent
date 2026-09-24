# Codex Session Title and Order Parity Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make refreshed AgentRoam Codex session titles and default ordering match Codex Desktop while preserving the user's running-first toggle as an explicit stable override.

**Architecture:** `CodexRuntimeAdapter` keeps its existing execution app-server and adds an independent discovery app-server for project and thread listings. First-page refreshes restart only discovery, all thread listings request `recency_at desc`, and the renderer keeps its existing stable running-first partition without code changes.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC, Vitest, Node 22, Bun workspace scripts

## Global Constraints

- Do not read or write Codex private SQLite databases in production code.
- Do not restart the execution app-server from a sidebar refresh.
- Preserve the native response order when running-first is disabled.
- Preserve existing running-first stable partition behavior when the user enables it.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Separate Codex Discovery Connection

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.ts`

**Interfaces:**
- Consumes: `CodexAppServerClient.request()`, `restart()`, `dispose()`, and `pid`
- Produces: constructor option `discoveryClient`, `refreshDiscoveryConnection()`, and discovery-only `project/list` / `thread/list` routing

- [x] **Step 1: Add the discovery-client boundary**

Define a structural client type next to `CodexThread`:

```ts
interface CodexDiscoveryClient {
  readonly pid?: number;
  request<T>(method: string, params: unknown): Promise<T>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}
```

Add `private readonly discoveryClient` and an optional constructor injection. Default it to a new `CodexAppServerClient` using the same resolved executable as the execution client.

- [x] **Step 2: Serialize discovery refreshes**

Add a shared restart promise so concurrent first-page refreshes perform one restart:

```ts
private discoveryRefreshPromise: Promise<void> | null = null;

private async refreshDiscoveryConnection(): Promise<void> {
  if (this.discoveryRefreshPromise) return this.discoveryRefreshPromise;
  const refresh = this.discoveryClient.restart().finally(() => {
    if (this.discoveryRefreshPromise === refresh) this.discoveryRefreshPromise = null;
  });
  this.discoveryRefreshPromise = refresh;
  await refresh;
}
```

When refreshing, clear only discovery-derived workspace snapshots/maps. Do not touch active execution queues or the execution client.

- [x] **Step 3: Route discovery requests and use native recency order**

Use the discovery client for `project/list` and all `thread/list` calls. Change each discovery sort contract to:

```ts
sortKey: "recency_at",
sortDirection: "desc",
```

Restart discovery for legacy full discovery and for first-page `query.refresh === true`; never restart cursor continuation pages. Keep `thread.name || thread.preview` mapping and response order unchanged.

- [x] **Step 4: Dispose and occupancy-track both clients**

Exclude both distinct client PIDs when checking open session files. Dispose both clients in parallel, deduplicating when tests inject the same object for both roles.

### Task 2: Focused Regression Coverage

**Files:**
- Modify: `packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts`
- Verify unchanged: `packages/desktop/renderer/lib/sidebar-session-sort.test.ts`

**Interfaces:**
- Consumes: `CodexRuntimeAdapter({ client, discoveryClient })`
- Produces: regression proof for fresh titles, recency sorting, refresh isolation, pagination, disposal, and the existing running-first override

- [x] **Step 1: Inject discovery doubles into existing list tests**

Give existing discovery tests a stub with `request`, `restart`, `dispose`, and optional `pid`. Keep execution notification handling on the original client.

- [x] **Step 2: Assert the official ordering contract**

Update full, project, legacy-root, and direct-path expectations from `updated_at` to `recency_at`, preserving `sortDirection: "desc"`.

- [x] **Step 3: Cover cross-process title refresh and execution isolation**

Return an old preview before restart and a current native name after restart. Call the path listing with `{ refresh: true }` and assert the new name appears, discovery `restart()` runs once, and execution `restart()` never runs.

- [x] **Step 4: Cover cursor and disposal behavior**

Assert a cursor continuation does not restart discovery. Assert distinct execution/discovery clients are both disposed and a shared injected client is disposed once.

- [x] **Step 5: Confirm the user-controlled running-first behavior**

Run the existing sidebar sort tests. They must continue proving that source order is preserved by default and running-first stably partitions running/non-running sessions when manually enabled.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
nvm use 22 >/dev/null && bunx vitest run \
  packages/native-runtime/src/agent-runtime/codex-runtime-adapter.test.ts \
  packages/desktop/renderer/lib/sidebar-session-sort.test.ts
nvm use 22 >/dev/null && bun run --cwd packages/native-runtime build
nvm use 22 >/dev/null && bunx tsc --noEmit -p packages/desktop/tsconfig.json
git diff --check
```

Expected: all focused tests pass, native-runtime build succeeds, desktop TypeScript succeeds, and the diff check reports no whitespace errors.
