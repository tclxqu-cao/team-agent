# Task Completion System Notifications Design

## Goal

Notify the user through the operating system when a user-initiated AgentRoam task completes. Desktop, WebApp, and TUI should share completion semantics and user preferences while using platform-specific notification delivery. A notification should include an audible cue when the platform permits it.

## Current State

- Core exposes the terminal `AgentEvent` variants `done`, `error`, and `turn_aborted`.
- Desktop and TUI already consume those events to settle run state, but neither has a task-completion system notification boundary.
- Server already observes both Customer Agent and native runtime events through `agentHost.setGlobalEventObserver()` and sends Web Push for `done`, `error`, and approval events.
- The PWA service worker displays Web Push payloads as operating-system notifications. Browser and operating-system policy controls whether those notifications make a sound.
- The current Web Push duplicate guard uses only `sessionId + kind` and a 1.5-second window. It does not identify an individual run.

## Domain Boundaries

Task completion is an application fact derived from the existing run event stream. Operating-system notification delivery is infrastructure. The Agent domain and `AgentLoop` must not import Electron, browser, shell-command, or operating-system notification APIs.

The shared Core application layer will own:

- the notification intent and preference types;
- the rule that maps a terminal run outcome to a notification intent;
- stable identity for duplicate suppression;
- a port implemented by each host environment.

The platform packages will own:

- permission checks;
- foreground detection;
- operating-system notification APIs;
- sound behavior and platform fallback;
- notification click handling;
- best-effort failure logging.

## Application Contract

Add a Core application module for task notifications with these conceptual contracts:

```ts
export interface TaskCompletionNotification {
  notificationId: string;
  sessionId: string;
  runId: string;
  title: string;
  body?: string;
}

export interface TaskNotificationPreferences {
  completionEnabled: boolean;
  soundEnabled: boolean;
  notifyWhileForeground: boolean;
}

export interface TaskNotificationPort {
  notifyCompletion(
    notification: TaskCompletionNotification,
    preferences: TaskNotificationPreferences,
  ): Promise<void>;
}
```

The application policy accepts an authoritative top-level run settlement and returns either a completion intent or no intent. It has no side effects and can be tested without a platform runtime.

`notificationId` is derived from the stable `sessionId` and `runId`. It is used as the Electron tag, Web Push tag, and local duplicate key. If a legacy Customer Agent path has no explicit run ID, the host must assign one when admitting the run and carry it through settlement; timestamps are not a valid identity substitute.

## Completion Semantics

A completion notification is produced only when all of the following are true:

- the user initiated the top-level run;
- the authoritative terminal event is `done`;
- the run has not already produced a notification intent;
- completion notifications are enabled;
- the host is backgrounded, or `notifyWhileForeground` is enabled.

The following do not produce a completion notification:

- `error` and `turn_aborted` events;
- sub-agent completion events;
- replayed history and reconnect snapshots;
- intermediate turns automatically started by Thread Goal;
- a terminal event for a stale run after a newer run has started in the same session.

Thread Goal produces one notification when the goal reaches its final successful outcome. Its intermediate `done` events remain ordinary turn settlements and do not notify.

This feature initially handles successful completion only. Error and approval notifications already supported by Web Push remain unchanged and are outside the shared completion policy.

## Platform Adapters

### Desktop

The Electron main process implements `TaskNotificationPort` using Electron's native `Notification` API. The renderer reports run settlement through the existing preload/IPC boundary; it never imports Electron notification APIs directly.

The adapter:

- checks `Notification.isSupported()`;
- uses `notificationId` as the notification tag or local duplicate key;
- shows the session title and a bounded final-answer preview;
- focuses the existing window and selects the originating session when the notification is clicked;
- requests sound through the native notification when `soundEnabled` is true;
- may use Electron's system beep only when the native notification implementation cannot provide an audible cue;
- logs and swallows delivery failures so notification failure cannot alter run completion.

Desktop foreground means the AgentRoam window is focused and the originating session is selected. With the default preference, that state suppresses the notification.

### WebApp

The existing server observer and Web Push service become the Web implementation of the same application intent. No client-side duplicate completion notification is added.

The adapter:

- sends `notificationId`, `sessionId`, title, bounded body, and an `/app/` navigation target in the push payload;
- uses `notificationId` for durable duplicate suppression during process lifetime and as the service-worker notification tag;
- keeps Web Push best effort and removes expired subscriptions as it does today;
- opens or focuses WebApp and routes to the originating session when the notification is clicked.

The Web platform cannot reliably choose or force notification audio. `soundEnabled` expresses user intent, but actual sound remains controlled by browser, PWA, and operating-system notification settings. The UI must not claim that a custom sound is guaranteed.

Server-side Web Push cannot reliably know whether a particular browser tab is foregrounded. WebApp therefore sends completion push whenever enabled; the service worker/browser may coalesce or suppress presentation according to platform policy. A later presence protocol may refine this without changing the Core contract.

### TUI

The TUI host invokes its adapter only after the top-level run has settled successfully and any Thread Goal continuation has finished.

The adapter uses a small platform gateway:

- macOS: invoke the system notification facility without shell interpolation;
- Windows: invoke the supported Windows toast facility through an argument-safe process API;
- unsupported or unavailable native notification facilities: emit terminal bell `\u0007` when sound is enabled;
- non-interactive stdout: skip terminal bell and system notification unless an explicit interactive TTY is present.

The TUI is considered foreground while its process owns the active interactive terminal. Therefore the default `notifyWhileForeground = false` suppresses TUI notifications during normal interactive use. Users who want completion cues while working in another terminal pane can enable foreground notifications.

## Preferences

Expose three user preferences with these defaults:

| Preference | Default | Meaning |
| --- | --- | --- |
| Completion notifications | On | Permit successful task-completion notifications. |
| Sound | On | Request a platform sound or terminal-bell fallback. |
| Notify while foreground | Off | Notify even while the originating host is active. |

Preferences are host-level user settings, not properties of the Session aggregate. Desktop and WebApp share the existing renderer settings surface where practical; TUI exposes equivalent config through its existing persistent model/config mechanism. Missing stored values use the defaults so existing installations migrate without a destructive settings rewrite.

## Data Flow

1. A host admits a user-initiated top-level run and assigns or records its stable `runId`.
2. Runtime events continue through the existing Agent event stream.
3. On authoritative settlement, the host supplies run identity, outcome, session metadata, Thread Goal state, and preferences to the Core application policy.
4. The policy returns no intent or one `TaskCompletionNotification`.
5. The host calls its `TaskNotificationPort` implementation.
6. The adapter checks platform capability and foreground state, then delivers the notification and optional sound.
7. Adapter failures are logged and do not modify run or session state.

## Duplicate And Race Handling

- Duplicate identity is `notificationId = sessionId + runId + completion-kind`, not a timing window.
- Every adapter keeps a bounded set of delivered notification IDs for its process lifetime.
- Web Push uses the same ID as the service-worker `tag`, allowing the operating system to coalesce retries.
- Replayed SSE events, history hydration, and native transcript reconciliation do not enter the notification policy.
- A completion event is ignored if its `runId` does not match the host's current or just-settled run record.
- Clicking an old notification may open the session, but it must not restart or mutate the run.

## Error Handling

Notifications are optional side effects. Unsupported APIs, denied permissions, unavailable operating-system commands, and push delivery failures are logged at warning or debug level and swallowed. They must not change a completed run into an error or delay prompt restoration.

Notification bodies are bounded and use the existing user-visible final answer. Internal reasoning, tool arguments, credentials, and hidden steering content are never included.

## Verification

Implementation verification should cover:

- Core policy tests for success, failure, abort, sub-agent, Thread Goal intermediate/final, foreground preference, stale run, and duplicate identity;
- Desktop adapter tests for capability checks, focus/session routing, sound preference, duplicate suppression, and failure isolation;
- Server/Web Push tests for stable tags, run-level deduplication, bounded payloads, and expired subscriptions;
- service-worker tests or contract checks for payload parsing and session navigation;
- TUI adapter tests for platform command argument safety, TTY checks, terminal-bell fallback, duplicate suppression, and failure isolation;
- focused integration verification that one successful top-level task produces one notification in Desktop, WebApp, and TUI while errors, aborts, sub-agents, and Thread Goal intermediate turns produce none.

## Non-Goals

- Custom audio files or volume controls.
- Guaranteed Web notification sound.
- A new notification center or notification history UI.
- Notifications for every tool, sub-agent, intermediate turn, failure, or abort.
- Changing Agent event protocol semantics solely for presentation.
- Persisting notification delivery as domain state.
