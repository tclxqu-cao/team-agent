# Web Host Project Picker Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the embedded Web app register a directory on the AgentRoam host and create Agent sessions that operate in that real project directory.

**Architecture:** A shared `HostPathPolicy` canonicalizes and validates configured roots. The nonce-authenticated `/web` WebSocket owns project CRUD and directory listing, while a strict same-origin `postMessage` bridge exposes those RPCs to the `/app` iframe. Session creation and Customer Agent runs resolve cwd from the server-side project store.

**Tech Stack:** TypeScript, React 18, Next.js route handlers, Node.js WebSocket/PTY gateway, SQLiteProjectStore, Vitest.

## Global Constraints

- Continue storing the canonical project path in `Project.description`; do not add a database migration.
- Browser File System Access, upload/sync, directory mutation, Git clone, and worktree creation remain out of scope.
- `AGENT_WEB_ROOTS=/` must allow descendants after canonical containment validation.
- Project deletion must never delete host files.
- Existing native sessions keep their native cwd.
- Do not expose a new open HTTP filesystem-listing endpoint.

---

### Task 1: Shared Host Path Policy

**Files:**
- Create: `packages/core/src/infrastructure/HostPathPolicy.ts`
- Create: `packages/core/src/infrastructure/HostPathPolicy.test.ts`
- Modify: `packages/core/src/infrastructure/index.ts`
- Modify: `packages/server/ws-server.mjs`

**Interfaces:**
- Produces: `HostPathPolicy.fromEnvironment(value, fallbackRoot)`, `policy.roots`, `policy.assertAllowed(path)`, `policy.assertDirectory(path)`, and `policy.listDirectories(path)`.
- Consumes: Node `path`, `fs`, and configured `AGENT_WEB_ROOTS`.

- [ ] **Step 1: Add canonical containment and typed errors**

Implement `HostPathError` with codes `PATH_OUTSIDE_ROOT`, `PATH_NOT_FOUND`, `PATH_NOT_DIRECTORY`, and `PATH_UNREADABLE`. Canonicalize candidates with `realpathSync`; use `path.relative` containment so `/`, sibling prefixes, `..`, and symlink escapes behave correctly.

- [ ] **Step 2: Add immediate directory listing**

Return `HostDirectoryEntry[]` containing `name`, canonical `path`, and `hasChildren`. Exclude entries that cannot be resolved, are not directories, or resolve outside configured roots; sort normal names before dot-directories.

- [ ] **Step 3: Test root and symlink boundaries**

Use temporary directories to prove `/` containment, normal-root containment, sibling rejection, missing/non-directory errors, and symlink escape rejection.

- [ ] **Step 4: Replace WebSocket string-prefix policy**

Instantiate one configured policy at gateway startup. Use it for project operations and use a derived policy including active PTY cwd only for existing read-only file RPCs.

### Task 2: WebSocket Project RPC

**Files:**
- Modify: `packages/server/ws-server.mjs`
- Create: `packages/server/lib/web-project-contract.ts`
- Create: `packages/server/lib/web-project-contract.test.ts`

**Interfaces:**
- Consumes: `HostPathPolicy`, `SQLiteProjectStore`, and the existing correlated WebSocket request protocol.
- Produces: RPCs `project:list`, `project:get`, `project:create`, `project:rename`, `project:delete`, `project:roots`, and `project:directories`.

- [ ] **Step 1: Define stable Web project DTOs**

Map storage `{ description }` to renderer `{ description }` for existing compatibility while ensuring stored paths are canonical. Normalize names from `path.basename`, using `/` for the filesystem root.

- [ ] **Step 2: Implement CRUD handlers**

Validate every created path with `assertDirectory`, return an existing matching project on duplicate canonical path, rename names only, and call `SQLiteProjectStore.delete()` without filesystem operations.

- [ ] **Step 3: Implement roots and directory handlers**

Return configured canonical roots and immediate allowed child directories through the existing correlated result/error frames.

- [ ] **Step 4: Test bridge-independent contract parsing**

Cover valid methods, malformed payload rejection, finite request IDs, and response/error shapes in the pure contract helper.

### Task 3: Iframe Project Bridge And Web Gateway

**Files:**
- Create: `packages/server/app/web/webappProjectBridge.ts`
- Create: `packages/server/app/web/webappProjectBridge.test.ts`
- Modify: `packages/server/app/web/page.tsx`
- Create: `packages/webapp/src/infrastructure/web-shell-project-bridge.ts`
- Create: `packages/webapp/src/infrastructure/web-shell-project-bridge.test.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`
- Modify: `packages/webapp/src/main.tsx`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/main/preload.ts`

**Interfaces:**
- Produces: `WebShellProjectBridge.request(method, payload)`, plus `AgentApi.listProjectRoots()` and `AgentApi.listProjectDirectories(path)`.
- Consumes: parent WebSocket `rpc`, exact `window.location.origin`, and exact iframe `contentWindow`.

- [ ] **Step 1: Define and test the versioned message contract**

Use request type `agent-webapp:project-request:v1` and response type `agent-web-shell:project-response:v1`. Require same origin/source, an integer request ID, an allowlisted method, and object payload.

- [ ] **Step 2: Broker iframe requests through parent rpc**

In `/web`, listen only to the mounted iframe source, map allowlisted methods to same-name WebSocket RPCs, and post success/error responses with the exact origin.

- [ ] **Step 3: Implement iframe request correlation**

Install one response listener, track pending requests with 15-second timeouts, reject on bridge errors, and reject project operations with `WEB_SHELL_REQUIRED` when `/app` is standalone.

- [ ] **Step 4: Replace synthetic Web projects**

Make `AgentHttpGateway` list/get/create/update/delete/check paths through the bridge. Preserve `Project.description` as the path expected by shared renderer code.

- [ ] **Step 5: Maintain desktop AgentApi parity**

Expose directory-list methods in the shared type and preload. Desktop implementations may return the selected directory through existing IPC-backed file operations but are not called by the desktop picker branch.

### Task 4: Web Host Directory Picker UI

**Files:**
- Create: `packages/desktop/renderer/components/HostProjectPicker.tsx`
- Create: `packages/desktop/renderer/components/HostProjectPicker.test.ts`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: `packages/desktop/renderer/styles/global.css`

**Interfaces:**
- Consumes: `AgentApi.listProjectRoots()`, `AgentApi.listProjectDirectories(path)`, and an `onConfirm(path)` callback.
- Produces: a portal modal with root selection, breadcrumbs, directory rows, refresh/back/cancel/confirm commands, and loading/error/empty states.

- [ ] **Step 1: Build focused picker state helpers**

Implement exported pure helpers for breadcrumb construction and path-label formatting; test `/`, normal macOS paths, and names that need wrapping.

- [ ] **Step 2: Build the portal modal**

Render a compact work-focused dialog with accessible labels, stable dimensions, mobile-safe width, keyboard focus, and no arbitrary text-path input.

- [ ] **Step 3: Replace the Web import rejection**

Open the picker when `webShell` is true. Reuse the existing project creation, reload, selection, expansion, and notice flow after confirmation. Preserve Electron `openFileDialog()` behavior.

- [ ] **Step 4: Add focused structural tests**

Assert the component exposes loading/error/empty copy, confirm/cancel controls, breadcrumb helpers, and that `App.tsx` no longer contains the old Web rejection message.

### Task 5: Project-Scoped Session Working Directory

**Files:**
- Modify: `packages/server/app/api/agent-host.ts`
- Modify: `packages/server/app/api/sessions/route.ts`
- Modify: `packages/server/app/api/agent-host.test.ts`
- Modify: `packages/server/app/api/native-runtime.test.ts`

**Interfaces:**
- Consumes: `projectId`, `SQLiteProjectStore`, and `HostPathPolicy`.
- Produces: `AgentHost.resolveProjectWorkingDirectory(projectId)`, native create options containing project cwd, and Customer Agent runs built with project cwd.

- [ ] **Step 1: Expose validated project resolution**

Return the configured default only for project-less Customer Agent sessions. For a supplied project ID, require a stored project with a currently allowed existing directory; return typed 400/404 responses instead of home-directory fallback.

- [ ] **Step 2: Pass cwd into native session creation**

Resolve `body.projectId` before `NativeRuntimeService.create()` and pass the project canonical path as `cwd`. Require a project for new Codex and Claude Code sessions.

- [ ] **Step 3: Build Customer Agent runs with session cwd**

Resolve the stored session project at run start, set the builder working directory for that build, and restore the default configuration after build so later project-less sessions cannot inherit it.

- [ ] **Step 4: Test cwd routing and no fallback**

Create temporary project directories, persist project rows, verify native create receives the exact canonical cwd, verify Customer Agent build observes the selected cwd, and verify missing/disallowed paths fail before runtime invocation.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/core/src/infrastructure/HostPathPolicy.test.ts \
  packages/server/lib/web-project-contract.test.ts \
  packages/server/app/web/webappProjectBridge.test.ts \
  packages/webapp/src/infrastructure/web-shell-project-bridge.test.ts \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts \
  packages/desktop/renderer/components/HostProjectPicker.test.ts \
  packages/server/app/api/agent-host.test.ts \
  packages/server/app/api/native-runtime.test.ts
bun run --cwd packages/webapp typecheck
bun run --cwd packages/core build
bun run --cwd packages/webapp build
```

Expected: all tests, type checks, and builds pass. Fix implementation or test failures and rerun until green.
