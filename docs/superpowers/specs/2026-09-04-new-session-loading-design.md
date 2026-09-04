# New Session Loading Design

## Goal

Creating a session must acknowledge the click immediately, prevent duplicate creation, and move the user into the new conversation as soon as the create request succeeds. The behavior must remain consistent across the shared Electron and WebApp renderer and across Customer Agent, Codex, Claude Code, and OpenCode.

## Current Delay

`App.handleNewRuntimeSession` waits for `window.agentApi.createSession(...)` without exposing pending state. Codex creation performs `thread/start`, `thread/name/set`, and `thread/unsubscribe` requests in sequence. OpenCode may also need to initialize its client before creating a session.

Customer Agent adds another avoidable wait: after persistence succeeds, the handler awaits a workspace session-list refresh before selecting the new session. During all of these operations the clicked button remains unchanged and active, so normal asynchronous latency looks like a frozen interface and repeated clicks can create duplicate sessions.

## Design Decision

Track one in-flight creation in `App` as the target Agent and workspace. New-session creation is a single global action: while it is pending, all create entry points are disabled so a second click cannot start another request.

The two existing entry points expose the same state:

- The bottom primary action replaces the plus icon with `LoaderCircle`, changes its label to `正在创建...`, and sets `aria-busy=true`.
- The target workspace row replaces its compact plus icon with the same spinner and sets an accessible `正在创建会话` label.
- Other workspace create buttons are disabled during the request but do not show the target spinner.

The spinner reuses the existing global `spin` keyframe and skin color tokens. Button dimensions do not change between idle and pending states. No page-level overlay is introduced because session creation does not need to block reading the current conversation.

## Success Flow

After `createSession` returns, every runtime follows the same immediate renderer path:

1. Normalize the returned summary to the workspace where creation was requested.
2. Insert or replace the summary at the top of that workspace's session list.
3. Select the workspace and new session.
4. Close the mobile drawer when applicable.

Customer Agent then starts a background workspace refresh to reconcile the optimistic row with persisted data. Native runtimes retain their optimistic row because their discovery APIs may hide an empty session until its first turn. The existing explicit pending-session reconciliation remains the authority for later refreshes.

## Failure And Concurrency

The handler uses `try/catch/finally`. A failure leaves the current selection unchanged, shows the existing page-level error notice with the runtime error message when available, and always clears the pending state. The pending state is also cleared after success.

The active Agent may change while the request is running. The pending identity therefore includes both Agent and workspace: the spinner is only rendered when the visible partition matches the request, while completion still applies the result to the workspace originally passed to the handler.

## Validation

Renderer contract coverage will verify that:

- both create entry points expose the pending state;
- the target entry renders `LoaderCircle` and the bottom label changes to `正在创建...`;
- all entry points are disabled while creation is pending;
- `aria-busy` and accessible labels reflect creation state;
- success inserts and selects before Customer Agent's background refresh;
- failure reports an error and `finally` clears pending state.

The focused renderer test, Desktop and WebApp TypeScript checks, and `git diff --check` form the implementation gate.

## Out Of Scope

This change does not alter runtime creation protocols, make Codex naming or unsubscribe fire-and-forget, add cancellation, or introduce a full-page loading overlay.
