# Mobile session list performance implementation plan

> **For the main agent:** Implement directly in this session without subagents. Run affected tests after implementation and fix failures before delivery.

**Goal:** First load 20 session summaries; fetch the next 20 on scroll and load history only for the selected session. Pause polling in inactive Shell frames.

**Architecture:** Shell publishes frame activity using same-origin messages and a child handshake. Shared page activity gates UI refreshes while keeping components mounted. The catalog uses its existing stable cursors and server search. SQLite supplies summaries without reading messages/events.

**Tech Stack:** React 18, Next.js 14, TypeScript, SQLite, Vitest.

## Constraints

- Preserve unrelated dirty messaging changes; no Git commit or push.
- No project docs changes. `docs/code-standards.md` is absent; follow `CLAUDE.md`.
- Do not stop running agent tasks when a UI frame is inactive.
- Preserve server catalog search, deduplication, stable pagination and stale-response protection.

## Tasks

- [x] Add a tested activity controller and Shell handshake. Guard polling in chat, Dashboard, messaging, collaboration, and session utilities.
- [x] Replace automatic all-page catalog loading with `limit: 20` requests. Fetch later cursors only on scrolling or the load-more button; debounce server search and ignore late responses.
- [x] Add optional `ISessionStore.listSummaries()` and a SQLite implementation selecting session columns only; use it in catalog discovery.
- [x] Run affected Vitest tests, WebApp typecheck and build. Verify 20/40 pagination, full-catalog search, inactive-page request suspension and selected-session history loading in Ego.
- [x] Build Next output in an isolated directory with Node 22. Check owned active runs before applying to 3000, then verify live assets, stable PID and browser behavior. Record results in wiki.
