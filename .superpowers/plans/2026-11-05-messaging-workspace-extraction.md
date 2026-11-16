# Messaging Workspace Extraction Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extract message intake, listening, intent recognition, project routing and delivery into the independently buildable `@agent/messaging` workspace package.

**Architecture:** The package owns messaging types, state transitions, SQLite persistence, channel adapters, model recognition/routing, knowledge retrieval, conversational replies and delivery. Host applications inject a model factory, data directory and execution port; the package never imports server or desktop code. Intake, routing, execution observation and delivery advance independently under the existing cross-process worker lease.

**Tech Stack:** TypeScript, Bun build, Vitest on Node, existing core SQLite/model interfaces, Python channel readers and the existing macOS sender helper.

## Global Constraints

- Preserve all current dirty work, source payloads, SQLite table names, account/conversation identities, execution bindings and delivery semantics.
- Use ordinary Git only; do not commit, push, publish, restart services or send real messages for validation.
- Keep `@agent/core` external in the package bundle and consume core's built declarations when emitting this package's declarations.
- External message text and wiki snippets are reference data; model classification remains tool-free and candidate targets remain allowlisted.
- Unknown dispatch or delivery is reconciled rather than replayed. Existing direct replies, group mentions and rule routing retain their admission behavior.
- Keep project documentation unchanged; this implementation plan lives under `.superpowers/` in accordance with the current docs boundary.

### Task 1: Extract the owned files and public package

**Files:** Create `packages/messaging/package.json`, `tsconfig.json`, `build.mjs`, `src/index.ts`; move core messaging domain/application/repository files into the corresponding directories under `packages/messaging/src`; move server channel assets to `packages/messaging/assets/wecom` and adapters to `src/channels/wecom`.

**Interfaces:** Export `ChannelMessage`, `MessageRecord`, `RoutingDecision`, `MessagingService`, `SQLiteMessagingRepository` and the focused ports from `@agent/messaging`. Core remains a one-way dependency for `AgentType`, model contracts and its shared database singleton.

- [x] Move tracked files using Git and preserve existing working-tree content; move untracked message files without dropping them.
- [x] Build with `bun build ./src/index.ts --outdir ./dist --target node --format esm --external @agent/core`; copy only non-test channel assets into `dist/assets/wecom`.
- [x] Replace consumers' messaging imports with `@agent/messaging`; remove the old core exports and direct imports into former messaging directories.

### Task 2: Define intake, recognition, routing, execution and sender ports

**Files:** `src/application/ports.ts`, `src/application/MessagingService.ts`, `src/intake/MessageIntake.ts`, `src/recognition/model-recognizer.ts`, `src/routing/model-router.ts`, `src/reply/model-reply.ts`, `src/model.ts`.

**Interfaces:**

```ts
interface MessageRecognition {
  kind: "task" | "reply" | "review" | "ignore";
  reason: string;
  knowledgeQuery?: string;
  model?: string;
}
interface MessageRecognizer {
  recognize(source: ChannelMessage, context: RoutingContext[]): Promise<MessageRecognition>;
}
interface MessageRouter {
  route(source: ChannelMessage, candidates: RoutingCandidate[], context: RoutingContext[], recognition: MessageRecognition): Promise<RoutingDecision>;
}
interface MessageSource {
  collect(): Promise<void>;
  discover(): Promise<{ sources: Array<{ database: string; accountId: string }>; error?: string }>;
}
interface MessageSender {
  send(delivery: DeliveryRecord, source: ChannelMessage): Promise<DeliveryResult>;
}
interface MessagingExecution {
  candidates(): Promise<RoutingCandidate[]>;
  createSession(record: MessageRecord): Promise<string>;
  dispatch(record: MessageRecord): Promise<{ queueItemId: string; runId?: string }>;
  observe(record: MessageRecord): Promise<ExecutionObservation>;
}
```

- [x] `MessageIntake.receive` normalizes admission through the existing repository and `collect` shares one in-flight source collection, including refreshes requested by delivery verification.
- [x] Recognition produces an intent and topic terms without choosing a project; the router retrieves wiki evidence and chooses only a registered candidate. Direct replies and ignore decisions need no execution target.
- [x] Inject a `MessagingModelFactory` returning `{provider, model}`; keep shared settings resolution in the server.
- [x] Wire the application service through `{recognizer, router, execution, replies, sender}` and persist recognition alongside final routing evidence.
- [x] Retain tests for candidate validation, context privacy, durable deduplication, unknown outcomes and manual confirmation; update fixtures to focused dependencies.

### Task 3: Separate stage progress and server composition

**Files:** `src/listening/MessagingWorker.ts`, `src/listening/MessagingWorker.test.ts`, `packages/server/lib/messaging/service.ts`, `packages/server/lib/messaging/execution.ts`, `execution.test.ts`, `model.ts`, `packages/server/app/api/messaging/route.ts`.

**Interfaces:** `MessagingWorker(repository, service, intake)` exposes `tick()` and `close()`. A shared owner renews the existing worker lease while any stage is busy. Per-stage in-flight guards prevent overlapping invocations; another tick may advance idle stages while a model call or source read is still running.

```ts
await Promise.allSettled([
  stage("collect", () => intake.collect()),
  stage("route", () => service.routePending()),
  stage("execute", () => service.executePending()),
  stage("deliver", () => service.deliver()),
]);
```

- [x] Preserve collection status and stage errors, keep lease renewal active during long calls, and drain in-flight work on close before releasing ownership.
- [x] Keep the server execution adapter limited to project discovery and native session execution/observation; assemble all other components from the package.
- [x] Have source discovery use the intake adapter, with no API import of channel internals.
- [x] Add deferred-promise tests proving collection and delivery can continue while routing is blocked, stages do not overlap, and a second worker cannot take the lease prematurely.

### Task 4: Wire build, staging and incremental release inputs

**Files:** Root and consumer `package.json`/`tsconfig` files, `bun.lock`, server Next config, desktop builder config, `scripts/incremental-cli-release.mjs` and its tests, `stage-cli-runtime.mjs`, `stage-agent-packages-for-packaging.mjs`, `audit-runtime-tarball.mjs`, `build-wecom-send-helper.mjs`.

- [x] Add workspace dependencies and source aliases; build messaging after core and before its consumers.
- [x] Treat changes under `packages/messaging/` as invalidating both platform runtimes; leave unrelated TUI package versions alone.
- [x] Externalize the package in Next, copy its dist and Python/Swift assets into runtime bundles, and materialize it for desktop packaging while excluding sourcemaps.
- [x] Resolve channel assets from the package's dist/source or the installed runtime; never assume the previous server source directory exists.
- [x] Keep the messaging package free of native Agent SDK dependencies, so SDK-specific upgrade manifests and smoke imports remain unchanged unless actual references require updating.
- [x] Add regression coverage for package invalidation, build order and packaged asset availability.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run `bunx vitest run packages/messaging packages/server/lib/messaging packages/desktop/renderer/components/messaging packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts` and Python discovery under `packages/messaging/assets/wecom`.

Run `node --test scripts/*.test.mjs` for the updated release/staging scripts and existing runtime upgrade guards.

Build core and messaging, run package/server/desktop type checks and build the shared Web UI. Verify Node can import the built module with one shared core instance. Exercise runtime staging and desktop staging in isolation where possible; restore development workspace links after desktop staging. Report any existing build prerequisite that prevents a full platform bundle check without representing it as passed.

- [x] Capture the actual package boundaries, verification evidence and remaining activation state in wiki.


## Verification results (2026-11-05)

- `bunx vitest run packages/messaging packages/server/lib/messaging packages/desktop/renderer/components/messaging packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`: 129 tests pass across 14 files.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s packages/messaging/assets/wecom -p '*_test.py'`: 22 tests pass.
- `node --test scripts/*.test.mjs`: 106 pass, 1 expected skip. Corrected one existing upgrade-guard occurrence count from 13 to the 15 occurrences already present in HEAD; no runtime SDK version changed.
- Core and messaging builds pass. Messaging's dist is approximately 58 KB and imports core externally. Server and isolated messaging-UI TypeScript checks pass, including source aliases verified with TypeScript resolution. Full desktop TypeScript still reports existing App/chat/sidebar/config errors outside this change; no diagnostics reference the messaging components.
- `NEXT_STANDALONE=1 NEXT_DIST_DIR=.next-messaging-extraction NODE_OPTIONS=--max-old-space-size=8192 bunx next build` passes in the server directory. The built messaging API keeps `require("@agent/messaging")` external. Isolated Web UI build into `/tmp/agentroam-messaging-webapp-dist` passes.
- `NEXT_DIST_DIR=.next-messaging-extraction node scripts/stage-cli-runtime.mjs --target darwin-arm64 --output-dir /tmp/agentroam-messaging-runtime-stage` passes. A real npm pack and `audit-runtime-tarball.mjs` pass for the temporary artifact: 30,216,278 bytes, 8134 entries. Its preview.71 version is the existing repository metadata, not a new npm publication.
- `node scripts/messaging-package-smoke.mjs /tmp/agentroam-messaging-runtime-stage/runtime/node_modules/@agent/messaging` passes: actual Node import, shared core database singleton, temporary database queries and all channel assets.
- Desktop staging into a temporary `--desktop-root` creates real directories for core/computer-use/native-runtime/messaging, excludes messaging maps/source tests and passes the same Node smoke. Development workspace links remain unchanged.
- The actual system model independently recognizes the screenshot message as a task and selects the registered refund project using four Refund wiki pages. The check reads settings through a read-only SQLite connection and never instantiates the execution or delivery workers.
- Moved-file index changes were unstaged to restore the original working-tree boundary. Existing parallel work is preserved. No commit, push, service restart, package installation into the live application, real message send or npm publication occurred.
- Historical findings and verification boundaries are captured in wiki `_raw/2026-11-05-agentroam-messaging-package-extraction.md`. Project docs remain unchanged; the message flow documentation is a follow-up candidate.
