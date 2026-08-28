# TUI Command and Context Palette Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Ink-based TUI with live Agent progress, discoverable slash commands and skills, project/file/folder at-mentions, and persistent model selection.

**Architecture:** Keep `agent-tui.mjs` as the executable Bun launcher and move behavior into focused TypeScript/TSX modules. Pure modules own commands, resources, model configuration, and state transitions; an Agent runtime adapter owns session and Agent lifecycle; Ink components render the transcript, palette, questions, and composer from state.

**Tech Stack:** Bun 1.3+, Ink 5.2.1, React 18.3, TypeScript 5.6, Vitest 2.1, ink-testing-library 3.0.

## Global Constraints

- Preserve `packages/tui/agent-tui.mjs` as the executable npm bin and preserve its executable mode.
- Do not re-enable semantic skill matching; opening `/` must not call a model.
- Keep `~/.customer-agent-tui` as the TUI data directory and write model config with file mode `0600`.
- Do not persist manually entered API keys; manual models use `AGENT_API_KEY`.
- Ignore `.git`, `node_modules`, `.next`, `dist`, `build`, `coverage`, and hidden cache directories while indexing resources.
- A project or model switch creates a new session; a failed rebuild keeps the existing runtime.
- Existing unrelated worktree changes must remain untouched.

---

### Task 1: TUI Package and Launcher

**Files:**
- Modify: `packages/tui/package.json`
- Modify: `packages/tui/agent-tui.mjs`
- Create: `packages/tui/tsconfig.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: Bun executable and the `@agent/core` workspace package.
- Produces: `startTui(argv: string[], env: NodeJS.ProcessEnv): Promise<void>` from `packages/tui/src/main.tsx`.

- [ ] **Step 1: Add explicit TUI dependencies**

Add `ink@^5.2.1` and `react@^18.3.1` to dependencies, plus
`@types/react@^18.3.24` and `ink-testing-library@^3.0.0` to dev dependencies.
Add TUI scripts for `typecheck` and focused tests.

- [ ] **Step 2: Add a TUI TypeScript configuration**

Extend the root config with `jsx: react-jsx`, `noEmit: true`, and an include for
`src/**/*.ts`, `src/**/*.tsx`, and tests.

- [ ] **Step 3: Reduce the executable to a stable launcher**

Keep the Bun shebang and replace inline behavior with:

```js
#!/usr/bin/env bun
import { startTui } from "./src/main.tsx";

await startTui(process.argv.slice(2), process.env);
```

- [ ] **Step 4: Update the root TUI script**

Keep `bun packages/tui/agent-tui.mjs` as the root command so existing usage does
not change.

### Task 2: Command and Palette Domain

**Files:**
- Create: `packages/tui/src/palette.ts`
- Create: `packages/tui/src/commands.ts`
- Create: `packages/tui/src/commands.test.ts`

**Interfaces:**
- Consumes: discovered skills shaped as `{ name: string; description?: string }`.
- Produces: `PaletteItem`, `PaletteState`, `getActiveTrigger`,
  `filterPaletteItems`, `createSlashItems`, and `parseSlashCommand`.

- [ ] **Step 1: Define palette types and filtering**

```ts
export type PaletteKind = "command" | "skill" | "project" | "folder" | "file" | "model" | "session" | "action";
export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  description: string;
  value: string;
  disabled?: boolean;
}
export interface ActiveTrigger {
  type: "slash" | "mention";
  start: number;
  query: string;
}
```

Detect `/` only at buffer offset zero. Detect `@` only at the start or after
whitespace and only for the token containing the cursor. Rank prefix matches
before substring matches and cap rendered results without mutating the source.

- [ ] **Step 2: Define the built-in command registry**

Register `/help`, `/new`, `/sessions`, `/open`, `/cwd`, `/model`, `/projects`,
`/skills`, `/clear`, and `/exit` with descriptions and whether they open a
secondary palette.

- [ ] **Step 3: Implement exact command parsing and skill pass-through**

```ts
export type SlashParseResult =
  | { type: "builtin"; name: string; args: string }
  | { type: "agent"; input: string };

export function parseSlashCommand(input: string, builtinNames: Set<string>): SlashParseResult;
```

Only exact registered built-ins return `builtin`; skills and unknown slash
messages return `agent` unchanged.

- [ ] **Step 4: Test trigger, ranking, and dispatch behavior**

Cover cursor-sensitive `@`, slash-at-start, disabled candidates, command/skill
group creation, exact command matching, known skill pass-through, and unknown
slash pass-through.

### Task 3: Project and Filesystem Candidates

**Files:**
- Create: `packages/tui/src/resources.ts`
- Create: `packages/tui/src/resources.test.ts`

**Interfaces:**
- Consumes: a current working directory and optional registered project records.
- Produces: `scanSiblingProjects`, `indexProjectResources`, `mergeProjects`,
  `replaceMentionToken`, and `ProjectCandidate`.

- [ ] **Step 1: Implement sibling project discovery**

Use `fs.promises.opendir(dirname(cwd))`, include immediate non-hidden
directories, resolve real paths, and mark the current project.

- [ ] **Step 2: Implement bounded recursive resource indexing**

```ts
export interface ResourceIndexOptions {
  maxEntries?: number;
  ignoredNames?: ReadonlySet<string>;
}

export async function indexProjectResources(
  root: string,
  options?: ResourceIndexOptions,
): Promise<PaletteItem[]>;
```

Walk asynchronously, skip ignored names and hidden cache directories, emit
folders and files with POSIX-style relative paths, stop at the configured cap,
and return permission warnings separately from usable results.

- [ ] **Step 3: Merge registered and discovered projects**

Normalize project names case-insensitively. Match registered names to sibling
basenames, accept a description only when it is an existing absolute directory,
deduplicate by real path, and retain unresolved database records as disabled.

- [ ] **Step 4: Implement mention replacement**

Replace only the active `@query` token. Insert `@relative/path` for ordinary
paths and `@"relative path"` when whitespace is present, then move the cursor to
the end of the inserted reference.

- [ ] **Step 5: Test filesystem boundaries and mention quoting**

Use temporary directories to cover ignored directories, file/folder grouping,
entry caps, permission errors, project deduplication, disabled unresolved
projects, and quoted insertion.

### Task 4: Desktop Data and Model Persistence

**Files:**
- Create: `packages/tui/src/desktop-data.ts`
- Create: `packages/tui/src/model-config.ts`
- Create: `packages/tui/src/model-config.test.ts`

**Interfaces:**
- Consumes: candidate application base directories, environment variables, and
  `~/.customer-agent-tui/config.json`.
- Produces: `readDesktopData`, `resolveStartupModel`, `saveTuiModelSelection`,
  `parseManualModel`, `ModelSelection`, and registered project records.

- [ ] **Step 1: Discover and read application databases without writing**

Use Bun's built-in SQLite driver in read-only mode, with a dynamic
`better-sqlite3` fallback for compatible runtimes. Open existing `agent.db`
files without creating or migrating them, validate `settings` and `projects`
tables, parse `profiles`, and close every connection. Catch missing modules,
ABI failures, locks, and bad JSON as warnings. Candidate paths include
development Desktop/Server bases and known packaged macOS userData locations.

- [ ] **Step 2: Define model resolution precedence**

```ts
export interface ModelSelection {
  source: "tui" | "desktop" | "env" | "manual";
  profileId?: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}
```

Resolve persisted Desktop profile reference first, Desktop active profile
second, then environment. Reject candidates without provider, model ID, or API
key without replacing the current valid model.

- [ ] **Step 3: Implement secure persistence**

Write config atomically through a temporary sibling file, chmod it to `0600`,
and rename. Persist Desktop source/profile ID and non-secret display fields; for
manual models persist provider/model ID/base URL only. Never serialize `apiKey`.

- [ ] **Step 4: Implement manual model parsing**

Accept `/model provider/model-id`, trim whitespace, require both segments, use
`AGENT_API_KEY`, and use `AGENT_BASE_URL` only when present. Return a precise
error for invalid syntax or missing credentials.

- [ ] **Step 5: Test precedence, persistence, and fallback**

Use temporary home/config paths and injected Desktop readers. Assert that API
keys never appear in saved JSON, mode is `0600`, stale profile references fall
back, malformed JSON produces a warning, and invalid manual input leaves the
active selection unchanged.

### Task 5: Agent Runtime Adapter

**Files:**
- Create: `packages/tui/src/runtime.ts`
- Create: `packages/tui/src/runtime.test.ts`

**Interfaces:**
- Consumes: `ModelSelection`, working directory, session store, event callback,
  and inline-question callback.
- Produces: `TuiRuntime` with `initialize`, `run`, `abort`, `newSession`,
  `openSession`, `listSessions`, `switchProject`, `switchModel`, and `skills`.

- [ ] **Step 1: Extract session persistence and listing**

Keep `FileSystemSessionStore` under `~/.customer-agent-tui`. Preserve JSON file
listing for cross-boot sessions and the 12-session display limit.

- [ ] **Step 2: Build Agents with explicit fast skill behavior**

Build with working directory, model credentials, session store,
`withSemanticSkillMatching(false)`, and `AskUserTool`. After build, expose
`builder.getSkillRegistry().getAll()` as command candidates.

- [ ] **Step 3: Make model/project switching transactional**

Build the replacement Agent first. Commit cwd/model/runtime state and create a
new session only after build succeeds. On failure, retain the previous Agent,
cwd, session, and model. Emit OSC 7 after a successful project switch.

- [ ] **Step 4: Normalize Agent events for the UI**

Forward the existing `thinking`, `text_chunk`, `text_done`, `tool_call`,
`tool_result`, `turn_aborted`, `error`, and `done` events without buffering the
whole turn. Set `preparing` before requesting the async iterator.

- [ ] **Step 5: Test builder configuration and rollback**

Inject an Agent factory and session store. Assert semantic matching is disabled,
skills are exposed, first progress precedes Agent events, and failed switches
leave all previous runtime state intact.

### Task 6: Ink State and Components

**Files:**
- Create: `packages/tui/src/state.ts`
- Create: `packages/tui/src/state.test.ts`
- Create: `packages/tui/src/components/Transcript.tsx`
- Create: `packages/tui/src/components/ProgressLine.tsx`
- Create: `packages/tui/src/components/CommandPalette.tsx`
- Create: `packages/tui/src/components/Composer.tsx`
- Create: `packages/tui/src/components/InlineQuestion.tsx`

**Interfaces:**
- Consumes: palette items and normalized runtime events.
- Produces: `tuiReducer`, `TuiState`, transcript entry types, and focused Ink
  presentation components.

- [ ] **Step 1: Define reducer state and actions**

Model transcript entries, streamed assistant text, progress timing, composer
buffer/cursor, history, active palette, selection, warnings, running state, and
inline-question state as a discriminated action reducer.

- [ ] **Step 2: Implement event-to-transcript reduction**

Update thinking in place, append text chunks to one assistant entry, retain tool
calls/results as rows, finalize elapsed/tokens once, and terminate progress on
abort/error.

- [ ] **Step 3: Implement composer key behavior**

Use Ink `useInput` to route arrows/Enter/Esc to an open palette first, then
support input insertion, deletion, cursor navigation, history, submit, and
Ctrl+C. Disable ordinary submit and palette selection while running.

- [ ] **Step 4: Implement stable rendering components**

Render a compact banner and status, bounded transcript viewport, one-line
progress timer, stable-height palette, question/options, and composer. Long
labels truncate within terminal width and no dynamic content changes the input
row height.

- [ ] **Step 5: Test reducer transitions**

Cover streaming order, tool visibility, elapsed completion, abort/error,
palette navigation and escape, Unicode insertion/deletion, history, question
priority, and clear-transcript behavior.

### Task 7: Application Orchestration and Built-ins

**Files:**
- Create: `packages/tui/src/App.tsx`
- Create: `packages/tui/src/main.tsx`
- Create: `packages/tui/src/App.test.tsx`
- Delete: `packages/tui/progress.mjs`
- Delete: `packages/tui/progress.test.ts`

**Interfaces:**
- Consumes: `TuiRuntime`, reducers, candidate providers, and all presentation
  components.
- Produces: the complete interactive TUI and exported `startTui` entry point.

- [ ] **Step 1: Initialize model, runtime, resources, and skills**

Resolve Desktop data and the persisted/default model before Agent creation.
Display recoverable warnings inside the TUI. Exit with a concise error only when
no model candidate has usable credentials or stdin is not interactive.

- [ ] **Step 2: Wire slash and at-trigger palettes**

Refresh slash candidates after every successful runtime rebuild. Build resource
index in the background on startup/project switch. Open, filter, navigate, and
close palettes based on the active cursor token.

- [ ] **Step 3: Implement built-in command handlers**

Implement help, new, sessions, open, cwd, model, projects, skills, clear, and
exit. `/open` and `/model` open secondary palettes when no argument is supplied.
Manual `/model provider/model-id` uses environment credentials. Skills and
unknown slash input run through the Agent.

- [ ] **Step 4: Wire turn execution and inline questions**

Append the user message before awaiting Agent output, apply each event as it
arrives, route `AskUserTool` through question state, and restore composer focus
after completion or abort.

- [ ] **Step 5: Add Ink integration tests**

Use an injected fake runtime to render the app and assert command/skill groups,
project/file/folder groups, arrow selection, model and session secondary
palettes, inline question answers, streamed thinking/tool/text order, and
Ctrl+C behavior.

- [ ] **Step 6: Remove obsolete imperative progress code**

Delete `progress.mjs` and its tests only after equivalent reducer and component
coverage passes.

### Task 8: Help Text and Runtime Verification

**Files:**
- Modify: `packages/tui/src/commands.ts`
- Modify: `packages/tui/src/App.tsx`

**Interfaces:**
- Consumes: completed TUI behavior.
- Produces: accurate visible help and verified interactive behavior.

- [ ] **Step 1: Finalize user-facing command descriptions**

Ensure `/help` names `/`, `@`, arrows, Enter, Esc, Ctrl+C, all built-ins, model
persistence, and project-switch session behavior in compact Chinese text.

- [ ] **Step 2: Run a PTY smoke harness**

Start the TUI with a harmless fake/local model adapter or existing configured
provider, send `/`, `@`, `/model`, and a prompt that invokes a tool, then verify
the palette opens immediately and thinking/tool rows appear before final text.

- [ ] **Step 3: Start the local TUI for user verification**

Launch `bun run tui` in a persistent terminal session with the resolved model
configuration and leave it running at a clean prompt.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/tui packages/core/src/domain/agent/AgentBuilder.test.ts packages/core/src/domain/skill/__tests__/SkillRegistry.test.ts
bunx tsc --noEmit -p packages/tui/tsconfig.json
git diff --check -- packages/tui package.json bun.lock
```

Expected: all focused tests pass, TUI typecheck passes, and diff check reports no
whitespace errors. If a test fails, fix the implementation or test and rerun
these commands until they pass. Report exact commands and results.
