---
title: Web Host Project Picker
date: 2026-09-01
status: review
---

# Web Host Project Picker

## Goal

AgentRoam Web users can register a project directory on the machine running the AgentRoam server, select it in the shared sidebar, and create Customer Agent, Codex, or Claude Code sessions whose real working directory is that project.

The browser does not upload, mirror, or mount a directory from the device displaying the page. A phone connected to a Mac-hosted AgentRoam instance edits files on that Mac.

## Product Contract

1. The project `+` button opens a host-directory picker in Web shell and the existing Electron system picker on desktop.
2. Web users can browse only directories allowed by `AGENT_WEB_ROOTS` and the host operating system.
3. Selecting a directory registers its canonical host path as a project; it does not copy files.
4. Project selection determines the working directory of newly created sessions for all supported runtimes.
5. Existing sessions retain their original working directory. Selecting another project does not silently move an existing native session.
6. Project deletion removes only the registration and disowns Customer Agent sessions according to the existing store behavior. It never deletes the directory or repository.
7. `AGENT_WEB_ROOTS=/` is supported after containment checks are fixed. The UI labels this as broad host access but does not block an explicitly configured root.
8. A terminal current-directory shortcut may preselect or register a project, but the directory browser remains the primary workflow.

## Terminology

- **Host**: the machine running `packages/server/ws-server.mjs` or the packaged AgentRoam runtime.
- **Browser device**: the phone or computer displaying `/web`.
- **Allowed root**: a canonical directory configured through `AGENT_WEB_ROOTS` or CLI `--root`.
- **Project path**: the canonical host directory stored in the existing `Project.description` field.

UI copy uses “宿主机项目” or “服务器项目” where the distinction matters. It does not call the browser device “本机”.

## Non-Goals

- Browser File System Access API integration.
- Uploading or synchronizing a browser-device repository to the host.
- Creating, deleting, renaming, or moving host directories.
- Git clone, worktree creation, repository initialization, or branch management.
- Changing the working directory of an existing Codex or Claude Code native session.
- Replacing `Project.description` with a new database column in this release.

## Architecture

### Shared host path policy

Add a path policy to `packages/core` and export it through `@agent/core` so the custom WebSocket server and Next server runtime use the same implementation. It owns:

- parsing `AGENT_WEB_ROOTS` with `path.delimiter`;
- canonicalizing configured roots and candidates;
- directory existence and type checks;
- containment checks based on `path.relative`, not string prefix concatenation;
- symlink escape prevention using `realpath` for both roots and candidates;
- stable error codes for missing, inaccessible, non-directory, and outside-root paths.

Containment is true when the canonical candidate equals the canonical root, or when `path.relative(root, candidate)` is a non-empty relative path that is neither `..`, prefixed by `..${path.sep}`, nor absolute. This handles `/` correctly and prevents sibling-prefix mistakes such as `/Users/foo2` matching `/Users/foo`.

Active PTY current directories may continue to extend the read-only file-tree policy. They do not automatically extend the project-registration policy: a registered project must be under an explicitly configured `AGENT_WEB_ROOTS` entry. This keeps terminal navigation from silently widening the paths an Agent may persist as projects.

### Project application service

Add a server application service around `SQLiteProjectStore`. The service exposes project-oriented DTOs while preserving the existing storage schema:

```ts
interface WebProject {
  id: string;
  name: string;
  path: string;
  created: string;
  updated: string;
}

interface HostDirectoryEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}
```

`WebProject.path` maps to and from `Project.description`. The service derives a default name from `path.basename(canonicalPath)`, rejects duplicate canonical paths with a conflict response, and never accepts an unvalidated path into the project store. The WebSocket host and Next session routes use the same `SQLiteProjectStore` database location.

### WebSocket project RPC

The Web console already establishes a WebSocket using a one-time nonce and origin checks. Extend that authenticated connection instead of adding an independently reachable HTTP directory-listing surface:

```text
project:list
project:get           { id }
project:create        { path, name? }
project:rename        { id, name }
project:delete        { id }
project:roots
project:directories   { path }
```

Behavior:

- `roots` returns canonical configured roots as picker entry points.
- `directories` returns immediate child directories only, sorted with dot-directories after normal names. It does not return files or recursively scan.
- `project:create` canonicalizes and validates the path again even when it came from `project:directories`.
- `project:rename` does not permit changing a project path. Users delete and re-register when the path changes.
- every operation runs only after the WebSocket bootstrap/nonce handshake has established the anonymous console principal;
- error bodies use stable codes such as `PATH_OUTSIDE_ROOT`, `PATH_NOT_FOUND`, `PATH_NOT_DIRECTORY`, `PATH_UNREADABLE`, `PROJECT_PATH_EXISTS`, and `PROJECT_NOT_FOUND`.

The parent `/web` page brokers these RPCs to the first-tab `/app` iframe through a versioned `postMessage` request/response contract. Both sides require `event.origin === window.location.origin`; the parent additionally requires `event.source === webappFrame.contentWindow`. Responses carry an opaque request ID and never accept a target origin of `"*"`.

### Shared renderer port

Extend the shared `AgentApi` port with directory-picker data operations rather than importing `fetch` into the desktop renderer:

```ts
listProjectRoots(): Promise<string[]>;
listProjectDirectories(path: string): Promise<HostDirectoryEntry[]>;
```

The Web `AgentHttpGateway` implements them through a small iframe bridge adapter and replaces its synthetic project methods with real project CRUD. Electron preload keeps the existing native `openFileDialog()` flow; the new list methods are present for interface parity but are not invoked by the desktop branch.

Opening `/app` outside the `/web` shell has no project bridge. The gateway reports a typed `WEB_SHELL_REQUIRED` error for project browsing or mutation instead of falling back to a fake successful project operation.

`setProjectWorkingDir()` remains meaningful only for the desktop Customer Agent host. Web must not pretend a global server working directory changed when project selection changes.

### Web directory picker

Add a Web-only modal rendered through `createPortal(document.body)` so it is not clipped by the sidebar or iframe layout. It contains:

- a root selector when multiple allowed roots exist;
- breadcrumb navigation;
- a scrollable immediate-child directory list;
- back, refresh, cancel, and “选择此文件夹” commands;
- loading, empty, permission-denied, stale-path, and disconnected states;
- the current canonical path, wrapping safely on narrow screens.

The picker does not accept arbitrary free-text paths in the first release. This keeps the interaction within server-listed locations and reduces path-entry mistakes. Keyboard users can navigate and confirm without a pointer; mobile rows maintain touch-sized targets.

On confirmation, `App.handleImportProject()` creates the project through `AgentApi`, reloads the project list, selects and expands the new project, and displays the existing success notice. Desktop behavior is unchanged.

### Terminal current-directory shortcut

The `/web` parent already tracks terminal current directories while `/app` runs in a same-origin iframe. Extend the same versioned bridge with the most recently focused live terminal cwd. The Web picker may offer “使用终端当前目录” only when that path also passes explicit-root validation.

This shortcut is optional for initial delivery. It must not be the only way to register a project and must not access parent React state directly through `window.parent`.

## Working Directory Semantics

### Session creation

The client sends `projectId`, not an arbitrary `cwd`, when creating from a selected project. The server resolves the project and its validated canonical path immediately before runtime creation.

- Customer Agent sessions store the selected `projectId`. Each run builds or configures the Agent loop with that project's path instead of the process-global server working directory.
- Codex and Claude Code session creation passes the resolved project path as `cwd` to `NativeRuntimeService.create()`.
- Project-less Customer Agent sessions may continue using the configured server default.
- Native session creation without a valid selected project fails with a typed validation error.

### Existing sessions

Native runtime history remains authoritative for its original cwd. Opening an existing Codex or Claude Code session never overwrites that cwd from the currently selected project.

For Customer Agent sessions, the project association is authoritative. If a registered path disappears or becomes disallowed before a run, the run fails before invoking tools and the UI marks the project invalid. It does not fall back silently to the server default or home directory.

### Global builder isolation

The server `AgentHost` currently owns a builder initialized with one readonly working directory. Replace global mutation with a per-run construction/configuration boundary so concurrent or sequential sessions cannot leak one project's cwd into another. A run captures its resolved cwd once at start; changing project registration during a run does not alter the active Agent.

## Security

1. Renderer input never directly becomes a filesystem root or runtime cwd.
2. Every browse and create request is revalidated against canonical configured roots.
3. `realpath` prevents symlinks inside an allowed root from escaping to an unallowed location.
4. Directory and project operations use the nonce-established WebSocket connection; no new open HTTP filesystem endpoint is added.
5. Directory listings contain directory names and canonical paths only, with no file contents.
6. Registering or deleting a project performs no filesystem write.
7. `/` means all paths allowed by the host OS and process permissions. macOS TCC and Unix permissions remain the final enforcement layer.
8. Logs record error codes and project IDs but do not dump directory contents, credentials, or file content.

Because Web access may be exposed through a tunnel, the UI shows a restrained warning when the selected configured root is `/`. The warning is informational; configuration remains an operator decision.

## Error Handling

- Configured root missing at startup: omit it from picker roots and log a diagnostic; fail startup only when no valid roots remain.
- Directory disappears while browsing: return `PATH_NOT_FOUND`, keep the modal open, and offer navigation to the nearest available parent/root.
- Permission denied: return `PATH_UNREADABLE`; do not broaden permissions or retry as another user.
- Duplicate project path: return the existing project ID so the renderer can select it rather than creating another row.
- Project removed between selection and session creation: return `PROJECT_NOT_FOUND` and preserve the unsent draft.
- Project path becomes disallowed after configuration changes: list it as invalid, block new runs, and allow deleting the registration.
- Runtime rejects cwd: surface the runtime error and keep the project selected for correction.

## Compatibility And Migration

No database migration is required. Existing desktop projects already store their path in `Project.description`; the Web API exposes that value as `path`.

The synthetic `web-default` project remains readable only as a compatibility bucket for existing Customer Agent sessions. It is not shown as a normal registered project once real projects exist, and new project-scoped sessions use a real stored project ID.

Deleting a project preserves current `SQLiteProjectStore.delete()` semantics: associated Customer Agent sessions become project-less. Native runtime histories are not deleted.

## Verification

Automated tests cover:

- path policy containment for `/`, normal roots, sibling prefixes, `..`, symlink escapes, missing paths, non-directories, and multiple roots;
- project service create/list/get/rename/delete, duplicate paths, and DTO/storage mapping;
- project WebSocket RPC handshake boundary, validation errors, and directory listing limits;
- iframe bridge origin/source checks, request correlation, timeout cleanup, and Web gateway project CRUD;
- Web picker loading, navigation, confirm, error, mobile overflow, and portal placement;
- App import behavior in Web and unchanged Electron dialog behavior;
- Customer Agent per-run cwd isolation across two projects;
- Codex and Claude Code creation receiving the selected project cwd;
- existing native sessions retaining their original cwd;
- invalid or newly disallowed project paths blocking runs without fallback.

Runtime verification on the target Mac proves:

1. Start with `AGENT_WEB_ROOTS=/` and browse from `/` into `/Users/caoqu/team-agent` without `EPATH`.
2. Register two repositories and confirm both persist after server restart.
3. From a phone browser, create one session in each repository and use `pwd` plus a harmless temporary-file round trip to prove the host path.
4. Confirm the temporary file appears in the actual host Git worktree and no browser-side copy exists.
5. Create Codex and Claude Code sessions and verify their native cwd matches the selected project.
6. Attempt a symlink escape and an out-of-root direct API request; both must fail.
7. Delete a project registration and confirm no host directory or repository content is removed.

## Rollout

Implement behind the existing Web shell detection; no user-facing feature flag is required. Build and test core, server, webapp, and desktop renderer contracts. After runtime verification, rebuild and restart the `:3000` production instance using the existing release workflow so `AGENT_WEB_ROOTS` is supplied explicitly.

Rollback restores the synthetic Web project gateway and previous session cwd behavior. Project rows created by the feature are harmless to older desktop code because they use the existing schema.
