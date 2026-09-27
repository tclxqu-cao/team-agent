# Task Completion System Notifications Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected type checks and builds before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one successful task-completion system notification, with an audible cue where the platform permits it, from AgentRoam Desktop, WebApp, and TUI.

**Architecture:** Core owns a pure application policy that turns authoritative run settlement into a platform-neutral notification intent. Server, Electron main, and TUI implement delivery adapters; run execution remains independent of operating-system APIs. Existing Web Push stays the Web adapter and receives stable run identity instead of creating a parallel event path.

**Tech Stack:** TypeScript, Node 22, Electron 44, React 18, Ink 5, Next.js 14, Web Push, PWA Service Worker.

## Global Constraints

- `AgentLoop` and Agent domain code must not import Electron, browser, shell-command, or operating-system notification APIs.
- Notify only a successful user-initiated top-level run; do not notify for `error`, `turn_aborted`, sub-agent completion, replayed history, or stale run settlement.
- Thread Goal intermediate turns do not notify; notify only after the final successful goal settlement.
- Duplicate identity is `sessionId + runId + completion-kind`; do not use a timing window as identity.
- Completion notifications default on, sound defaults on, and foreground notifications default off.
- Notification delivery is best effort and must never alter run outcome or delay prompt restoration.
- Notification text must use bounded user-visible content and must not include reasoning, tool arguments, credentials, or hidden steering messages.
- Web notification sound remains controlled by browser and operating-system policy.
- Do not add or run unit tests in this implementation unless the user requests them; verify with type checks and builds.

---

## File Structure

- Create `packages/core/src/application/notification/task-completion.ts`: pure notification types, defaults, intent policy, stable ID creation, and bounded in-memory deduper.
- Create `packages/core/src/application/notification/index.ts`: notification application exports.
- Modify `packages/core/src/index.ts`: export the notification application boundary.
- Modify `packages/core/src/domain/settings/entities.ts`: persist the three host-level notification preferences with backward-compatible optional fields.
- Modify `packages/core/src/infrastructure/SQLiteSettingsStore.ts`: supply defaults when old settings do not contain notification fields.
- Modify `packages/server/app/api/agent-host.ts`: pass stable run context to its global event observer for Customer Agent and native runs.
- Modify `packages/server/lib/push-hook.ts`: apply the Core policy and forward one completion intent to Web Push.
- Modify `packages/server/lib/web-push-service.mjs`: deduplicate by notification ID and include session navigation data.
- Modify `packages/server/public/pwa/service-worker.js`: use stable notification tags and navigate to the originating session.
- Modify `packages/server/lib/shared-settings.ts`: validate and persist notification preferences.
- Modify `packages/desktop/renderer/stores/settingsStore.ts`: load, edit, and save notification preferences.
- Modify `packages/desktop/renderer/components/SettingsPanel.tsx`: expose the three notification toggles.
- Create `packages/desktop/main/task-completion-notifier.ts`: Electron `Notification` adapter and click-to-focus behavior.
- Modify `packages/desktop/main/index.ts`: register a narrow IPC handler that invokes the adapter.
- Modify `packages/desktop/main/preload.ts`: expose only `notifyTaskCompletion(intent, preferences)` to the renderer.
- Modify `packages/desktop/renderer/global.d.ts`: type the narrow notification IPC contract and preference fields.
- Modify `packages/desktop/renderer/components/ChatView.tsx`: invoke Desktop notification only for accepted live terminal completion and suppress Thread Goal intermediate turns.
- Create `packages/tui/src/task-completion-notifier.ts`: macOS/Windows system delivery and terminal-bell fallback.
- Modify `packages/tui/src/model-config.ts`: persist notification preferences with defaults.
- Modify `packages/tui/src/commands.ts`: add notification preference commands.
- Modify `packages/tui/src/App.tsx`: remove direct `done/error` bell and notify once after the top-level queue/goal sequence finishes successfully.

### Task 1: Core Notification Application Boundary

**Files:**
- Create: `packages/core/src/application/notification/task-completion.ts`
- Create: `packages/core/src/application/notification/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/domain/settings/entities.ts`
- Modify: `packages/core/src/infrastructure/SQLiteSettingsStore.ts`

**Interfaces:**
- Produces: `TaskNotificationPreferences`, `DEFAULT_TASK_NOTIFICATION_PREFERENCES`, `TaskCompletionSettlement`, `TaskCompletionNotification`, `createTaskCompletionNotification()`, and `NotificationDeduper`.
- Consumes: existing session/run identity and final user-visible text.

- [ ] **Step 1: Add the pure application contract**

Create these exact public shapes:

```ts
export interface TaskNotificationPreferences {
  completionEnabled: boolean;
  soundEnabled: boolean;
  notifyWhileForeground: boolean;
}

export interface TaskCompletionSettlement {
  sessionId: string;
  runId: string;
  title: string;
  finalText?: string;
  outcome: "completed" | "failed" | "aborted";
  source: "user" | "goal" | "subagent" | "replay";
  goalFinished?: boolean;
  stale?: boolean;
}

export interface TaskCompletionNotification {
  notificationId: string;
  sessionId: string;
  runId: string;
  title: string;
  body: string;
}
```

`createTaskCompletionNotification(settlement, preferences)` returns `null` unless notifications are enabled, outcome is `completed`, source is `user`, or source is `goal` with `goalFinished === true`, and the run is not stale. Build the ID as `${sessionId}:${runId}:completed`, normalize the title to `任务已完成` when empty, and truncate the body to 160 Unicode code points.

- [ ] **Step 2: Add bounded duplicate suppression**

Implement `NotificationDeduper` with `accept(notificationId: string): boolean`, insertion-order eviction, and a default maximum of 500 IDs. The first call returns true; later calls for the same ID return false.

- [ ] **Step 3: Add notification preferences to settings**

Extend `SettingsData` with optional `taskNotifications?: TaskNotificationPreferences`. Old SQLite data resolves through `DEFAULT_TASK_NOTIFICATION_PREFERENCES`; saving unrelated settings preserves the current notification preference object.

- [ ] **Step 4: Export the boundary**

Export the new module from `packages/core/src/application/notification/index.ts` and `packages/core/src/index.ts` without adding platform imports to Core.

### Task 2: Web Push Adapter With Stable Run Identity

**Files:**
- Modify: `packages/server/app/api/agent-host.ts`
- Modify: `packages/server/lib/push-hook.ts`
- Modify: `packages/server/lib/web-push-service.mjs`
- Modify: `packages/server/public/pwa/service-worker.js`
- Modify: `packages/server/lib/shared-settings.ts`

**Interfaces:**
- Consumes: `createTaskCompletionNotification()`, `NotificationDeduper`, shared settings, Customer Agent `runId`, and native `_nativeRunId`.
- Produces: Web Push payload `{ notificationId, sessionId, title, body, url }` and a notification-click route containing `sessionId`.

- [ ] **Step 1: Carry run context through the global observer**

Change the observer signature to:

```ts
type GlobalEventObserver = (
  sessionId: string,
  event: AgentEvent,
  context: { runId?: string; source: "live" | "replay" },
) => void;
```

Pass the Customer Agent `runId` from `executeRun()` into `emit()`. For native events, resolve `runId` from `_nativeRunId`; events without a live run ID cannot generate a completion notification.

- [ ] **Step 2: Replace time-window completion deduplication**

In `push-hook.ts`, map only live terminal `done` events into `TaskCompletionSettlement`, apply shared preferences and the Core policy, then call Web Push only when `NotificationDeduper.accept()` succeeds. Keep existing approval/error pushes intact.

- [ ] **Step 3: Update Web Push payload and service worker**

Change `notifySession()` to accept the stable notification ID rather than deriving identity from `sessionId + kind`. Send `tag: notificationId`, `sessionId`, and `url: /app/?session=<encoded-id>`. The service worker uses the stable tag and focuses/navigates a matching client to that URL.

- [ ] **Step 4: Persist preference changes**

Allow `SharedSettingsService.save()` to accept exactly the three boolean notification fields, merge them with defaults, and reject non-boolean values.

### Task 3: Desktop Electron Adapter And Settings UI

**Files:**
- Create: `packages/desktop/main/task-completion-notifier.ts`
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/renderer/stores/settingsStore.ts`
- Modify: `packages/desktop/renderer/components/SettingsPanel.tsx`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Consumes: `TaskCompletionNotification`, `TaskNotificationPreferences`, Electron `Notification`, `BrowserWindow`, and live `done` events.
- Produces: `AgentApi.notifyTaskCompletion(notification, preferences): Promise<{ shown: boolean }>`.

- [ ] **Step 1: Implement the Electron adapter**

Create `DesktopTaskCompletionNotifier` with injected Electron notification constructor, main-window getter, and session-open callback. `notify()` checks support, duplicate ID, window focus plus selected-session state, and preferences. It creates a native notification with `title`, `body`, `silent: !soundEnabled`; click focuses/restores the main window and sends `task-notification:open-session` with the session ID. Failures return `{ shown: false }` and log without throwing.

- [ ] **Step 2: Add the narrow IPC bridge**

Register `task-notification:show` in Electron main, expose `notifyTaskCompletion()` from preload, and add its exact type to `AgentApi`. Validate all incoming fields and cap title/body lengths before passing them to the adapter.

- [ ] **Step 3: Persist and render preferences**

Extend the settings store persisted keys and defaults with `taskNotifications`. Add a `任务完成提醒` section to `SettingsPanel` with three labeled checkboxes/toggles: `任务完成通知`, `播放提示音`, and `前台运行时也通知`. Save through the existing revision-aware settings flow.

- [ ] **Step 4: Trigger only from accepted live completion**

In `ChatView`, retain the admitted/current run ID per session. On a live `done`, build the intent with the Core policy and invoke `notifyTaskCompletion()`. Do not invoke it for history hydration, `error`, `turn_aborted`, sub-agent events, stale native run IDs, or Thread Goal intermediate turns. Clear per-run tracking after terminal settlement.

### Task 4: TUI System Notification Adapter

**Files:**
- Create: `packages/tui/src/task-completion-notifier.ts`
- Modify: `packages/tui/src/model-config.ts`
- Modify: `packages/tui/src/commands.ts`
- Modify: `packages/tui/src/App.tsx`

**Interfaces:**
- Consumes: Core policy, TUI config preferences, `process.platform`, `process.stdout.isTTY`, and argument-safe `execFile`.
- Produces: `notifyTuiTaskCompletion(notification, preferences): Promise<boolean>`.

- [ ] **Step 1: Implement platform delivery**

Use `execFile` without a shell. On macOS call `/usr/bin/osascript` with a fixed script and pass title/body as argv values. On Windows invoke a fixed PowerShell toast script through `powershell.exe -NoProfile -NonInteractive -Command` with values supplied as encoded parameters. If native delivery is unavailable and `soundEnabled` is true on an interactive TTY, write `\u0007`. Resolve false on failure and never throw into the run loop.

- [ ] **Step 2: Persist TUI preferences**

Add `taskNotifications` to `TuiConfig`, merge absent or partial stored values with `DEFAULT_TASK_NOTIFICATION_PREFERENCES`, and retain config version 2 for backward compatibility.

- [ ] **Step 3: Expose TUI commands**

Add `/notifications on|off`, `/notification-sound on|off`, and `/notification-foreground on|off`. Each command updates only its boolean field, saves through `saveTuiConfig()`, and appends a concise confirmation notice.

- [ ] **Step 4: Notify after the complete top-level sequence**

Remove the current direct bell on both `done` and `error`. Generate one run ID when a user top-level input begins; track whether any terminal error/abort occurred. After Thread Goal continuation has stopped and before dequeuing the next independent user input, call the Core policy and TUI adapter once for a successful top-level sequence. Queued independent messages each receive their own run ID and notification.

### Task 5: Integration And DDD Self-Review

**Files:**
- Review: all files modified in Tasks 1-4
- Review: `docs/superpowers/specs/2026-09-27-task-completion-system-notifications-design.md`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: one coherent three-host feature with no platform dependency in Core.

- [ ] **Step 1: Trace every completion path**

Confirm Customer Agent and native runtime completion both carry stable run identity into Web Push and Desktop. Confirm TUI creates one identity per independent top-level input.

- [ ] **Step 2: Check DDD dependency direction**

Run `rg -n "electron|osascript|powershell|web-push|Notification" packages/core/src/application/notification packages/core/src/domain` and confirm the new Core application boundary contains only platform-neutral TypeScript.

- [ ] **Step 3: Check failure and replay boundaries**

Inspect every adapter call and confirm unsupported APIs, denied permissions, command failures, and push failures are swallowed/logged; replay/history paths and stale run IDs cannot call adapters.

- [ ] **Step 4: Check the final diff**

Run `git diff --check` and inspect `git diff --stat` plus each touched file. Confirm unrelated untracked files remain untouched.

## Final Build Verification

- [ ] **Main agent: run affected type checks and builds after development is complete**

Run with Node 22:

```bash
nvm use 22
npm run build --workspace @agent/core
npm run typecheck --workspace @agent/tui
npm run compile --workspace @agent/desktop
npm run build --workspace @agent/server
```

Expected: all commands exit 0. If a command fails, fix the implementation and rerun it until it passes. Report exact commands and results in the final response. Do not run unit tests unless the user requests them.
