# Direct Message Replies Implementation Plan

> **For the main agent:** Implement directly in this session without subagents. Run the affected unit tests after implementation and fix failures before reporting completion.

**Goal:** Receive incoming private WeCom messages without an @, route project tasks normally, and answer conversation from the owner's wiki and recent dialogue.

**Architecture:** Carry explicit conversation type from the local reader. Add a `reply` decision and a tool-free system-model reply adapter backed by bounded wiki retrieval. Persist reply evidence and deliver through the existing outbox using the official private-message API.

**Tech Stack:** Existing TypeScript, SQLite, Python reader, ModelRegistry, qmd CLI and wecom-cli.

## Global Constraints

- Incoming private messages enter model judgment; own messages never trigger, and groups retain direct-mention admission.
- Knowledge and conversation are reference data, never instructions. Reply generation cannot execute tools or claim unperformed actions.
- Keep project-task routing, approval permissions, receipt verification and no-blind-retry behavior.
- Keep private replies in their original conversation; persist knowledge sources and reply delivery separately.
- Preserve unrelated work. Use standard Git only. Do not modify project docs or publish npm packages.

## Task 1: Admission and persisted replies

- [ ] Add optional `conversationType` and `peerUserId` to `ChannelMessage`, `reply` to routing decisions, and reply knowledge evidence to execution.
- [ ] Admit `!ownMessage && (conversationType === "direct" || directMention)`; retain source deduplication and include own dialogue turns and sent replies in bounded context.
- [ ] Validate reply decisions, generate one persisted reply/outbox entry without creating an Agent session, and preserve independent send failure states.
- [ ] Cover private admission, group exclusion, own-message exclusion, reply deduplication, context isolation, and missing-text behavior in focused tests.

## Task 2: Knowledge and model adapters

- [ ] Extend model classification with `reply` and a contextual `knowledgeQuery`, including private chat when no project Agent is available.
- [ ] Resolve the wiki through env and existing obsidian-wiki config. Retrieve with qmd lexical search, bounded local fallback and compiled-page path checks; exclude raw archives and bookkeeping.
- [ ] Generate a short conversational reply using retrieved excerpts and both sides of recent conversation. Persist retrieval status and source paths.
- [ ] Cover malformed decisions, missing knowledge, path traversal, contextual retrieval and model failure.

## Task 3: WeCom source, delivery and audit UI

- [ ] Read `CONVERSATION.conversationtype` and the contact alias; preserve unknown types instead of guessing from message text.
- [ ] Decode the official CLI JSON-RPC envelope; verify the original text/time/sender and use `chat_type: 1` for private delivery, `2` for groups.
- [ ] Display private-reply result and knowledge evidence; include private messages in the default inbox filter.
- [ ] Cover private delivery, duplicate/ambiguous origin, expired authorization, group delivery regression, reader metadata and UI rendering.

## Final Unit Test Verification

- [ ] Run `bunx vitest run packages/core/src/application/messaging packages/core/src/domain/messaging packages/server/lib/messaging packages/desktop/renderer/components/messaging`.
- [ ] Run `python3 -m unittest discover -s packages/server/lib/messaging/wecom -p '*_test.py'`.
- [ ] Build core, Web UI and server using Node 22; inspect source diff and active sessions before the local gateway restart.
- [ ] Verify local listener/worker and a real knowledge-grounded reply. A real send requires restored official WeCom authorization; do not claim delivery without a success receipt.
- [ ] Capture findings and actual activation/acceptance state in the wiki.
