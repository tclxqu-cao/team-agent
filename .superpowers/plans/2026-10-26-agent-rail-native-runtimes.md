# Agent Rail and Native Runtimes Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After development, run affected tests, fix failures, and verify the full requirement checklist against live evidence.

**Goal:** Add the approved single-header icon-rail navigation, preserve all existing directory/session rendering and layouts/skins, and integrate Qoder, ZCode and WorkBuddy native sessions.

**Architecture:** Pure shared value types and wire contracts belong in core domain modules. Navigation preferences and views stay in presentation; browser storage and parent-frame messages adapt those values. Native process discovery and protocol clients stay in native-runtime infrastructure behind AgentRuntimeAdapter, registered at the broker composition root. No renderer component launches or imports a CLI client.

**Tech Stack:** TypeScript, React, Zustand, Next.js, Vite, Node child_process, NDJSON, Vitest, ego-browser.

## Global Constraints

- Preserve the existing directory toolbar, project rows, session rows, ordering, search, pagination, pinning and selection logic.
- Add only the sidebar icon rail and single header when the new navigation layout is selected.
- Keep classic navigation accessible at any time; standard/focus/compact and all skins, including glass, remain independent and intact.
- Add a layout switch immediately beside the shell skin switch and expose the equivalent control in desktop/standalone presentation.
- Keep the CA-only model-profile boundary from the preceding task.
- Preserve all pre-existing dirty changes. No commit, release or existing-service restart is authorized.
- Do not create/update project docs without separate permission. Plan files live outside docs.
- Do not copy native provider credentials. Use installed CLI login/configuration and environment overrides only.

### Task 1: Shared Agent identity and protocol discovery

Files: core domain agent type registry/index, native-runtime types/session-id, renderer global/cache/capability consumers, server API type guards.

- [x] Define the shared AgentType registry containing customer-agent, codex, claude-code, opencode, deepseek-harness, qoder, zcode and workbuddy. Replace duplicated type unions and runtime request allowlists with domain guards.
- [x] Recheck executable locations/versions and inspect installed protocol schemas. Probe initialize/list/read with bounded timeouts and redacted logs; retain process handles and dispose owned probes.
- [x] Keep provider/model configuration separate from Agent identity.

```ts
export const AGENT_TYPES = ['customer-agent', 'codex', 'claude-code', 'opencode', 'deepseek-harness', 'qoder', 'zcode', 'workbuddy'] as const;
export type AgentType = typeof AGENT_TYPES[number];
export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && AGENT_TYPES.some(type => type === value);
}
```

### Task 2: Independent navigation preference and safe frame bridge

Files: core domain web-console/navigation-layout.ts, renderer stores/uiStore.ts, webapp presentation web-shell navigation bridge, server app/web layout control/page.tsx, desktop header actions.

- [x] Define classic/agent-rail identity, default, normalization and message type as pure values.
- [x] Persist navigationLayout independently from skin and existing layout. Preserve all previous preference fields on migration.
- [x] Add the shell layout toggle beside ThemePicker, persist its selection, and deliver it to the console frame on changes and frame readiness. Reject wrong origins, sources and malformed layout messages in the receiver.
- [x] Add a desktop/standalone toggle with accessible current/next labels. Use current presentation tokens, not new global skin overrides.

```ts
export type NavigationLayout = 'classic' | 'agent-rail';
export const NAVIGATION_LAYOUT_MESSAGE = 'agent-web-shell:navigation-layout:v1';
export const nextNavigationLayout = (layout: NavigationLayout): NavigationLayout => layout === 'classic' ? 'agent-rail' : 'classic';
```

### Task 3: Approved sidebar composition without list changes

Files: renderer components/AgentWorkspaceHeader.tsx, AgentWorkspaceSwitcher.tsx, AgentBrandIcon.tsx, App.tsx, a new scoped sidebar-navigation.css.

- [x] Reuse the existing switcher in vertical mode in a dedicated first grid column; keep the old horizontal switcher in classic mode.
- [x] Render current Agent identity, connection/availability and close control as the sole header in rail mode. Preserve old branding/header in classic mode.
- [x] Place the untouched search, directory controls, directory list and footer into named grid areas. Do not change their DOM subtrees or handlers.
- [x] Use existing glass variables and scoped selectors so switching navigation never replaces chat styling.

```tsx
<aside className={`app-sidebar${navigationLayout === 'agent-rail' ? ' has-agent-navigation' : ''}`}>
  {navigationLayout === 'agent-rail' ? <AgentWorkspaceHeader /> : classicBrand}
  <AgentWorkspaceSwitcher vertical={navigationLayout === 'agent-rail'} />
  {existingSearch}{existingDirectoryToolbar}{existingDirectoryAndSessionList}{existingFooter}
</aside>
```

### Task 4: Runtime clients and adapters

Files: native-runtime/agent-runtime native-executable discovery, bounded stdio transport, Qoder ACP adapter/client, ZCode protocol adapter/client, WorkBuddy stream-json adapter/client, broker registration and exports.

- [x] Share only framing/process/error/timeout primitives; keep protocol schema conversion independent.
- [ ] Implement health, discovery, summary/history, creation, streamed text/tool/terminal events, abort and native continuation for all three.
- [x] Map permission requests to broker questions without auto-approval. Decline unsupported actions explicitly; never report unsupported goals/steering/models as supported.
- [x] Discover installed bundles with optional AGENT_QODER_BIN, AGENT_ZCODE_BIN and AGENT_WORKBUDDY_BIN overrides, and platform-specific fallbacks. Keep WorkBuddy force-lite/config child environment isolated.
- [x] Register all adapters in the broker host and all supported Agent types in facade/workspace/API routes.
- [x] Keep native history owned by the native runtime; persist only broker metadata and necessary local draft identity.

```ts
export interface NativeExecutable { command: string; args: string[]; env?: NodeJS.ProcessEnv }
export interface NativeProtocolClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  dispose(): Promise<void>;
}
```

### Task 5: Tests and live verification

- [x] Add domain registry/navigation validation tests, preference migration/independence tests, origin/source bridge tests, and header/switcher rendering tests.
- [x] Add fake-process protocol tests for fragmented lines, malformed output, reverse requests, permissions, cancellation, process exit, history and resumed second turns for each adapter.
- [ ] Verify actual CLI session creation, first response and same-session continuation for Qoder, ZCode and WorkBuddy in an isolated empty workspace. Record exact terminal evidence and clean up only owned temporary processes/sessions.
- [x] Build webapp into an isolated output directory, compare TypeScript diagnostics with pre-edit snapshots, and verify classic/rail plus glass/pearl through ego-browser at desktop and mobile widths. TypeScript acceptance remains not clean, as recorded below.
- [x] Audit imports for DDD boundaries: domain modules import no React/Node/process APIs; presentation imports no native protocol/process clients; executable/protocol details remain behind adapter contracts.
- [x] Capture reusable UI findings in wiki, naming the separate native-runtime acceptance boundary: `/Users/caoqu/.obsidian/wiki/_raw/2026-10-26-agentroam-compact-menu-cards.md`.

## Final Unit Test Verification

- [x] Main agent: run affected source-level unit tests after implementation. Compiled-package and real-runtime acceptance remain separate.

Commands: `bunx vitest run packages/core/src/domain/agent packages/core/src/domain/web-console packages/native-runtime/src/agent-runtime packages/desktop/renderer packages/webapp/src/presentation packages/server/app/web packages/server/app/api/agent-workspaces packages/server/app/api/agent/models`

Expected: focused suites pass; no newly introduced TypeScript diagnostics; isolated frontend build succeeds; original and rail layouts preserve the same session-list behavior with both glass and non-glass skins; all three real CLI continuations succeed.


## 2026-10-26 Additive UI Requests and Current Evidence

- [x] Add a 12px search-field top gap in agent-rail only. Browser-measured gap is 12px at desktop, 390px and 320px.
- [x] Collect existing header actions behind an icon-only ellipsis in agent-rail. Keep classic inline actions, callbacks, busy/disabled states, visibility settings and CA-only model settings intact.
- [x] Reuse shell actions in a glass-style desktop popover/mobile sheet, independent of skin. Keep skin and navigation layout controls adjacent.
- [x] Keep renderer menu controls mounted while hidden; child pairing dialogs use their own portals and must not be destroyed when the parent menu dismisses.
- [x] Add regression tests for compact/classic headers, CA model-settings isolation, icon-only rendering and disabled-empty overflow.
- [x] Finish shell mobile theme-picker/browser regression after fixing bottom-sheet popup clipping. The original 390px reproduction extended to y=1082; all seven themes now fit within the 844px viewport at both 390px and 320px.
- [x] Give skin and layout independent cards, kept adjacent by a transparent grouping wrapper. Distinguish Palette, PanelsTopLeft and FolderOpen icons.
- [x] Backfill the two-column group's mobile grid hole with `grid-auto-flow:row dense`. Browser-measured rows are 3/3/2 at 390px and 320px in pearl and glass skins, with one button per card and no horizontal overflow.

Verification as of this checkpoint:

- Final affected source-alias unit run: 826 passed, 1 skipped, 57 suites passed, 1 skipped. Evidence: `/tmp/agentroam-layout-native.0WGEIp/dense-final-source-tests.log`; source alias config: `/tmp/agentroam-layout-native.0WGEIp/vitest.config.mts`. Focused menu regression: 28 passed.
- An initial rerun without the isolated config resolved the unchanged compiled `@agent/core` package, missing `isAgentType`, and failed 5 suites/102 tests. Evidence is retained in `dense-final-affected-tests.log`. Do not claim the default compiled-package run is clean; a release must rebuild the dependency graph. No shared dist output was overwritten to hide this boundary.
- Isolated Webapp build passed in 9.32s. The final toolbar fixture rebuild passed in 680ms. Isolated native build passed (140 modules); native TypeScript check passed against freshly isolated core declarations.
- Renderer browser checks: desktop and 390/320px, icon menu open/dismiss, outside click, keyboard ArrowDown, Escape/focus return, 22px blur, no horizontal page overflow.
- Original directory/session JSX subtree remains byte-identical to the pre-edit tracked-source baseline; recompute the audit at final handoff.
- Desktop full typecheck is not clean: baseline 168, current 170 diagnostics. The increment adds two rootDir diagnostics for the shared domain source files; existing App status-type errors merely print the expanded AgentType union. Do not describe this as zero new diagnostics.
- Real CLI business acceptance remains open: Qoder native inference is resource/model-queue limited; WorkBuddy requires native login; ZCode app-server registry has zero models and lacks the native host account/provider-runtime bridge. A successful initialize/list/build/test is not a successful first or resumed response.
- No main-service restart, deployment, commit or push occurred. UI testing is isolated; its read-only proxy still uses the existing backend, not the new runtime adapters.
- Final screenshots: `/tmp/agentroam-layout-native.0WGEIp/dense-glass-menu-390.png` and `dense-glass-menu-320.png`. Measured evidence: `dense-glass-ui.json`. Fixture actions do not establish production backend acceptance.
- Restored the original exact pearl/classic UI preferences and Codex workspace. Finished owned browser space 28, then verified and stopped only owned preview PID 91860. Restoration evidence: `ui-restored-final.json`.

## 2026-10-26 Native Authentication and Result Verification

Previous goal turn classification: progress (mobile menu packing fixed and browser-verified). This goal turn is also progress: two native failure-handling corrections and real CLI evidence change the remaining work. The full objective remains active and unaccepted.

- [x] Replace an unsupported-callback exception for ZCode account headers with the protocol's explicit `headersApplied: false` result. Never provide CA credentials, reflect private request data, or turn account authentication into tool approval.
- [x] Reproduce WorkBuddy reporting a local login failure as a successful result. The native stream emitted `model: unknown`, null stop reason, zero-token usage and a success result; its owned JSONL preserved `status: incomplete` plus `providerData.error`.
- [x] Recognize only the exact native login-required/login-failed notices with those synthetic message markers. Preserve generated quotations and abort/native-error priority. The same real owned-session trigger now yields `error`, not `done`.
- [x] Run affected source tests after both corrections: 832 passed, 1 skipped, 57 suites passed, 1 skipped. Evidence: `/tmp/agentroam-layout-native.0WGEIp/native-auth-verified-source-tests.log`.
- [x] Run native type checking against fresh isolated core declarations and build a fresh isolated native bundle (140 modules). Evidence: `native-auth-verified-tsc.log` and `native-auth-verified-build.log`.
- [x] Recompute directory/search/session/footer preservation: baseline and current are byte-identical. The fresh extraction excludes the prior final newline and is 18,781 characters; both hashes are `dd1a2de8cb6b5173cf61e21eca2adfe94d63978d6d33d8b69524861d4c63f325`. New domain modules still import nothing. Evidence: `native-auth-preservation-audit.json`.
- [x] Capture current native protocol findings: `/Users/caoqu/.obsidian/wiki/_raw/2026-10-26-agentroam-native-auth-result-boundaries.md`.

Current installed versions were checked, rather than copied from earlier notes: Qoder CLI 1.1.38, ZCode App 3.16.3 / CLI 0.17.0, and WorkBuddy App 5.9.2 / CLI 2.165.0.

### Open Real-Runtime Gates

- [ ] Qoder: obtain a successful first response and same-session continuation. The advertised `dfmodel` test returned no text in 60 seconds and was cancelled; current native logs contain model-queue events. ACP advertises 14 official models and rejects the user's configured `magpie/qoder/kmodel_latest` ID, including with a child-only public capability override. This is not native Magpie acceptance.
- [x] Qoder native configuration scope: after explicit user approval, change only the 13 object-valued `capabilities.thinking` fields to `true`. All other JSON values, selected model, model count, routing, credentials and file mode `600` are unchanged. The CLI schema warning is gone. This closes the authorized configuration correction, not native inference acceptance; old and fresh ACP sessions still do not offer the configured Magpie model. Evidence: `qoder-authorized/verification-summary.json`.
- [ ] WorkBuddy: user completes native CLI login, then verify a real first response and native continuation. Account metadata and model discovery alone are not usable-authentication proof. Current post-fix evidence: `workbuddy-owned-session-after-auth-fix.json`.
- [ ] ZCode: implement/verify the native host-account/provider bridge through a supported interface, without mirroring credentials or substituting CA models. The current app-server registry exposes zero models and rejects both old and current account provider IDs. Guarded standalone prompt mode also has no selected model. Do not switch silently to its default yolo mode or call this integration complete.
- [ ] Desktop full typecheck gate remains open for pre-existing diagnostics. The two added rootDir diagnostics are resolved by the source/build configuration split below; the full tree still has 132 diagnostics, not a clean compile.

Only owned scratch sessions/processes were used. No main-service restart, deployment, commit, push or manual native credential-store edit occurred. The verified layout and directory/session-list code were not changed in this goal turn.

## TypeScript Source/Build Boundary Follow-Up

- [x] Reproduce the two added TS6059 errors. The old configuration produced 170 diagnostics, including 38 rootDir errors; removing the source-only project's emitting root produced 132 diagnostics with no rootDir errors and no new diagnoses.
- [x] Make `packages/desktop/tsconfig.json` a non-emitting main/renderer source-check project without a desktop-only rootDir. Keep all original source includes and path aliases.
- [x] Explicitly retain `rootDir: "."` and `noEmit: false` in `tsconfig.build.json`. The independent CommonJS preload project remains unchanged.
- [x] Add five effective-config/output-path regression tests in `packages/desktop/tsconfig.test.ts`, first failing against the old configuration and then passing. The new test file also has zero isolated compiler diagnostics.
- [x] Compare effective emitting options, all 49 emitting source roots and their output paths against saved pre-change configurations: identical. Electron's entry remains `dist/main/index.js`, and both preload outputs remain in `dist/main`.
- [x] Compare the preserved source snapshot with current source under the same final configuration: 132 diagnostics in each. 130 match exactly; the other two are the existing App status mismatch at identical source statements with identical underlying error causes, printed with expanded types. No added diagnostics remain. Raw reports and comparison details are retained under `/tmp/agentroam-layout-native.0WGEIp/typecheck-boundary/`.
- [x] Run all affected source-alias suites after the final test update: 837 passed, 1 skipped; 58 suites passed, 1 skipped. Evidence: `typecheck-boundary/all-affected-final-tests.log`.

No production build artifacts were written by the compiler checks. This closes only the increment's TypeScript regression gate, not the existing full-project diagnostics or the three native first-response/continuation acceptance gates. No unapproved Qoder settings, native credentials, main services or deployment state were changed.

## Native Blocked Audit After the TypeScript Follow-Up

The previous goal turn is progress: it resolved the increment's TypeScript boundary errors and verified unchanged Electron output paths. This turn revalidated the remaining native gates, without claiming repeated failures as implementation progress.

The same native blockers have persisted across three consecutive goal turns: the native-auth/result fixes, the TypeScript boundary follow-up and this fresh native revalidation. The first two turns still had safe non-blocked implementation work; that work is now finished. No additional authorized action remains that can establish native first-response and same-session continuation acceptance.

- Qoder's configured `magpie/qoder/kmodel_latest` still fails with `Invalid or unavailable model`. A separately and explicitly selected advertised native `dfmodel` returned no text in 60 seconds and was cancelled/disposed. This was not a silent fallback or successful Magpie inference. The native global settings hash is unchanged, and permission to correct `capabilities.thinking` is still pending.
- WorkBuddy's owned session still returns the exact native `/login` requirement, correctly surfaced as an error rather than success. Native CLI login requires user action; account metadata is not proof that model authentication works.
- ZCode's owned app-server session still exposes zero models. Its supported host-account/provider bridge is not available to this standalone client. Do not infer that the user has no ZCode account, execute private bundle internals, mirror native secrets, or substitute CA credentials.

Fresh evidence: `/tmp/agentroam-layout-native.0WGEIp/continuation-native/blocked-audit.json`, the four per-runtime result files and public-help captures. All probe tool handles reached terminal states. Tracked/untracked inventory was unchanged during the probes; no business source, global native configuration, credential store, main service or deployment was changed by this turn.

The full goal must be marked blocked, not complete. Resume on user authorization/native login or an available supported native host-account interface, then repeat real first-response and same-session continuation acceptance. Existing layout, source tests and DDD-preservation evidence do not close those native gates. No new wiki draft is necessary for this unchanged blocker; the existing native-auth/result-boundaries capture remains the reusable record.

## User-Authorized Qoder Thinking Schema Correction

The user explicitly approved only correcting `capabilities.thinking` in `/Users/caoqu/.qoder/settings.json`, while preserving models, routes and credentials. This turn makes concrete progress on that authorized configuration gate; it does not complete or shrink the full integration objective.

- [x] Inspect installed Qoder CLI 1.1.38 and reproduce `Expected boolean, received object`. All 13 affected capability objects advertised the `enabled` mode.
- [x] Locate exact JSON value spans with the TypeScript JSON AST, replace only those objects with `true`, and compare the complete parsed configuration against the expected field-only mutation. Preserve the surrounding text and native file mode `600`.
- [x] Keep only the original public thinking fragments for rollback; do not retain a credential-bearing full configuration copy.
- [x] Read back the configuration and verify the same configuration hash after all native checks. Every other JSON value remains unchanged. CLI `--version` and `--list-models` now produce no invalid-setting warning.
- [x] Test the previously owned ACP session with the exact configured `magpie/qoder/kmodel_latest`: the native runtime still returns `Invalid or unavailable model` before inference.
- [x] Create one new owned isolation session to rule out old-session state. It advertises 14 official models, reports current model `auto`, and neither advertises nor selects the configured Magpie model. Skip inference rather than silently using `auto`; no configured-model first response or continuation was accepted.
- [x] Capture the schema-versus-model-registry finding in `/Users/caoqu/.obsidian/wiki/_raw/2026-10-26-qoder-thinking-schema-and-acp-model-availability.md`.

Fresh session: `b140c184-3b91-496f-816a-218f7427c62d`. Evidence and public rollback fragments are under `/tmp/agentroam-layout-native.0WGEIp/qoder-authorized/`. Business source, other native accounts, main services, deployment state and project docs were not changed. Qoder's Magpie registry/ACP availability and all real native first-response/continuation gates remain open. Do not re-request permission for the thinking-only correction: that approved change is now applied and retained.

## 2026-10-27 Current-State Completion Audit

- [x] Re-read current project rules and verify the worktree, branch and running 3000 service. Preserve all unrelated changes.
- [x] Run the expanded affected regression selection: 1913 passed, 29 failed, 1 skipped across 211 suites. Do not substitute the earlier 35-test dot check for full objective acceptance.
- [x] Re-run native-runtime type checking: passed. Desktop checking still reports 131 diagnostics; no full desktop typecheck acceptance is claimed.
- [x] Query live native health, workspaces, first-directory sessions and models. All three runtimes return data; Qoder has 18 directories/14 models, ZCode 28/15, WorkBuddy 4/9. Listing is not inference acceptance.
- [x] Add and run an explicit dependency-boundary gate for shared domain identities, navigation presentation and all three native protocol clients. The final gate contains 24 passing checks.
- [x] Recompute preservation of the existing directory/session subtree and classify expanded-suite failures against the retained baseline. Current, HEAD and before-ellipsis JSX are identical after trimming trailing newlines (18,780 characters, SHA-256 `b9f58d5f9d231a187014e8a7dadbb2d67ed5c4b7838ecfc2591de5584450afbc`). All 23 final failures also reproduce against HEAD sources using the same assertions.
- [ ] Verify actual native response and continuation where the configured model and native account allow it. Do not substitute other models, copy credentials, or equate healthy metadata with inference.
- [x] Complete the requirement-by-requirement audit, retaining unverified native and visual acceptance boundaries. Completing this audit does not complete the goal.

Current audit evidence lives under `/tmp/agentroam-goal-audit-20261027/`. The existing browser verification space 42 no longer exists; do not create a replacement to route around it without user authorization.

### ZCode Reasoning Metadata Repair

- [x] Reproduce the real native failure in the existing owned fixture: explicit native `magpie/zcode/GLM-5.3` was rejected with `invalid_model_request: Reasoning level is required`.
- [x] Read the actual native capability: `reasoning.levels` advertises low/high/max and `reasoning.defaultLevel` is max. Do not invent a model or effort default.
- [x] Project supported effort levels in the native adapter and retain provider/model-scoped native defaults across partial history reads. Honor explicit per-turn choices before defaults. The renderer now consumes advertised capabilities rather than restricting the effort picker to two hardcoded Agents.
- [x] Cover metadata filtering/deduplication, default preservation, explicit overrides, unadvertised defaults and provider isolation. Preserve CA/native separation and Claude's existing fallback.
- [x] Run focused verification: 92 passed. Final expanded regression: 1975 passed, 23 HEAD-baseline failures, 1 skipped. Native type checking passes; desktop remains at exactly 131 diagnostics with zero added or removed diagnostics. The 7 skins x 3 existing chat-layout combinations all pass.
- [x] Build native-runtime and Webapp into isolated staging directories; Webapp build takes 5.43 seconds. The unchanged Next API artifact explicitly requires external `@agent/native-runtime`, so native bundle replacement plus gateway restart is required, but rebuilding unchanged Next routes is not.
- [ ] Obtain a real response and same-session continuation: the omitted-effort reproduction no longer returns the parameter error, but no reply arrives within 90 seconds; cancel only the owned probe. Canonical native history confirms no visible assistant response, so do not claim inference acceptance.
- [ ] Activate the staged native/Webapp pair on 3000 after the Web OpenCode run is confirmed terminal. At 11:56:36 +0800, the broker still reports an OpenCode run owned by the web controller. PID 46426 owns the shared native socket; no service restart or partial rollout is performed.

Current Qoder verification still rejects the configured `magpie/qoder/kmodel_latest` before any prompt; the native configuration hash is unchanged. WorkBuddy's existing owned fixture still returns `AUTHENTICATION_REQUIRED` and requires native `/login`. These are not closed by discovery, metadata health, unit tests or a build.


### 2026-10-27 12:12 CST - pointed Agent-dot verification and native quota evidence

- [x] Matched the user's latest red boxes to the small availability badges above the vertical Agent icons, not to the connection header or session status dots. The existing `!vertical` condition is present in the actual 3000 bundle `/app/assets/index-J4FkkUbr.js`; the original horizontal layout retains its badges. Focused switcher tests: 3 passed. No additional source edit was needed at this checkpoint.
- [x] The existing owned ZCode trace completed its 240-second observation deadline. Actual `session/send` was accepted with native default `reasoningLevel=max`, then native requests to Magpie (`http://127.0.0.1:3425`) repeatedly returned HTTP 429. The final inspected retry at 12:05:58 CST carried upstream code 1308: the 5-hour usage cap is exhausted and resets at 2026-10-27 14:07:46. This is an upstream quota rejection, not proof of a broken streaming parser. The exact HTTP route is absent from the inspected log fields; do not invent it.
- [x] Cancelled/disposed only the already-owned trace. No global model/provider/credential changes or replacement inference requests. No browser space was recreated to bypass the missing original space.
- [ ] The 3000 process still reports a Web-owned running OpenCode session, with retry events in fresh detail. No terminal evidence yet; the staged native reasoning repair remains unactivated and no restart was attempted. All 462 recorded source hashes still match the staged build.
- [ ] Native first-response/continuation and fresh visual acceptance remain open. Qoder model availability and WorkBuddy login boundaries are unchanged; do not claim end-to-end success.

Evidence: `/tmp/agentroam-goal-audit-20261027/dot-and-zcode-quota-checkpoint.json` and `/tmp/agentroam-zcode-native-trace.9vrOWk/rate-limit-summary.json`. Temporary evidence paths are not durable archives.


### 2026-10-27 ZCode native retry-feedback implementation plan

Use the existing approved integration architecture, not a new conversation layout. Installed ZCode emits `model_request_started`, `model_retry_scheduled`, and `model_request_completed` as `session.updated` payloads. The current protocol client ignores those payloads, hiding upstream quota backoff from the shared progress display.

Files: new infrastructure-only `zcode-model-progress.ts` and unit tests; update `zcode-client.ts` and its adapter integration tests; extend the existing architecture gate to include the new translator. No domain, renderer, session-directory or session-list change.

- [x] Add a pure native-telemetry projection into existing `AgentEvent.runtime_progress`. Use a stable progress identity; expose only explicit native messages, valid attempts/max attempts and actual native backoff delay. Never forward headers, credentials or raw metadata.
- [x] Wire the projection after existing session/sequence guards. Request start/completion replace stale retry state; only native turn completion/failure remains terminal. Ignore unrelated session updates.
- [x] Cover retry-to-success, repeated quota-to-native-failure, duplicate sequence, session isolation, malformed counters and omitted/raw secret-bearing metadata. Keep existing approval, history, model and abort tests intact.
- [x] Run affected native/runtime, progress-state and DDD tests plus native type checking. Build a new isolated native bundle and refresh the staging fingerprint; do not activate or restart a service with a still-owned active run.
- [x] Capture the concrete fix and honest acceptance boundary in a new wiki raw note. Actual native inference remains gated by configured Qoder model availability, WorkBuddy login and ZCode upstream quota; no model/credential substitution.


Verification: 300/300 tests passed in 9 files, including 25 DDD boundary checks. Native no-emit checking, isolated native bundle (142 modules) and declaration output pass. The current staged manifest covers 463 production-source hashes and points to `native-dist-retry-feedback`; the existing Webapp staging output is reused because no renderer/Webapp source changed. Previous staging manifest is retained as `staged-release.pre-retry-feedback.json`. No production artifact was replaced and PID 46426 was not restarted.

Completion remains unproven. The release gate has recurred at the current-state audit (11:56), pointed-dot/quota checkpoint (12:12), and this continuation's live preflight (12:18): a Web-owned OpenCode run is still reported active by the live broker. Direct read-only native health requires process-owned authentication (HTTP 401); do not bypass it or treat the broker flag as proof that the native run ended. Qoder's explicitly configured native Magpie model rejection, WorkBuddy's native login requirement and ZCode's upstream five-hour quota also remain unclosed. No new inference was launched to consume quota or silently substitute another model. The original browser task space is still unavailable; no replacement space was created without authorization.

Remaining external actions are unchanged: obtain a terminal live-run state or explicit permission to interrupt that particular run for release; complete WorkBuddy native login and make the authorized Qoder model available; retry ZCode acceptance after upstream quota restoration; obtain permission to resume visual acceptance in a new browser task space. The latest code change is fully staged, not deployed or end-to-end accepted.
