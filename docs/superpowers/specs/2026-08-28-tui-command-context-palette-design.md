# TUI Command and Context Palette Design

## Goal

Replace the readline-based TUI shell with an Ink interface that preserves live
thinking, tool, and streaming response output while adding discoverable command
and context palettes:

- Typing `/` at the start of the composer opens built-in commands and discovered
  skills.
- Typing `@` at a token boundary opens projects, files, and folders.
- `/model` selects Desktop model profiles or accepts a manual provider/model ID,
  and the selection persists as the TUI default.
- Selecting a project changes the TUI working directory. Selecting a file or
  folder inserts a reference into the message.

## Chosen Approach

Use Ink and React as the TUI rendering framework. The current program already
has several pieces of mutable terminal state: the editable input line, live
elapsed progress, streamed assistant text, tool records, inline questions, and
now two nested palettes. A single React render tree gives those states explicit
ownership and makes later panels and forms easier to add.

The existing `packages/tui/agent-tui.mjs` remains the executable Bun entry point.
It imports a TSX application module so the npm bin path and executable bit remain
stable. Ink and React become explicit dependencies of `@agent/tui`.

## Architecture

### Application State

`TuiApp` owns:

- active working directory and session ID;
- active model profile and Agent instance;
- transcript entries and the currently streamed assistant entry;
- turn lifecycle (`idle`, `running`, `asking`, `aborting`);
- composer buffer and cursor;
- active palette and selected candidate;
- non-fatal status and error notices.

Agent creation stays outside React rendering in a small runtime service. Changing
the project or model disposes the current runtime and builds a new Agent. A
project change also creates a new session so context from one project is not
silently reused in another.

### UI Components

- `Transcript` renders user messages, thinking stages, tool calls/results,
  assistant chunks, token usage, and errors.
- `ProgressLine` derives its elapsed label from state and a timer hook. It does
  not write terminal control codes directly.
- `Composer` handles text insertion, deletion, cursor movement, history, submit,
  Ctrl+C, and palette routing through Ink's input API.
- `CommandPalette` renders a stable-height, scrollable candidate list with group,
  label, description, selected state, and disabled state.
- `InlineQuestion` renders `ask_user` prompts and temporarily owns composer
  submission without hiding transcript progress.

Pure reducers and candidate providers remain separate from components so their
behavior can be tested without a real terminal.

## Slash Commands and Skills

The built-in registry contains:

- `/help`: show commands and key bindings;
- `/new`: create a session;
- `/sessions`: list recent sessions;
- `/open`: open a session through a second-level session palette;
- `/cwd`: show the current directory;
- `/model`: show a second-level model palette;
- `/projects`: show the project palette;
- `/skills`: show discovered skills;
- `/clear`: clear the visible transcript without deleting the stored session;
- `/exit`: close the TUI.

Typing `/` at the beginning of the buffer opens a palette grouped into
`Commands` and `Skills`. Further text filters candidates case-insensitively by
name and description. Arrow keys move selection, Enter inserts/selects, and Esc
closes the palette without changing the buffer.

Built-in commands are intercepted only when their first token exactly matches a
registered command. A slash name present in `AgentBuilder.getSkillRegistry()` is
sent unchanged to `AgentLoop`, allowing explicit skill invocation. Unknown slash
input is sent as an ordinary user message rather than rejected locally.

Commands with secondary choices open another palette. Commands can also be
entered directly, including `/open <session-prefix>` and
`/model <provider>/<model-id>`.

## At-Mention Resources

Typing `@` at a token boundary opens a palette grouped into `Projects`,
`Folders`, and `Files`. Text following the active `@` filters the list by label
and relative path.

Project candidates merge and deduplicate:

1. immediate, non-hidden child directories of the current directory's parent;
2. projects registered in readable Desktop and Server SQLite stores.

SQLite project records contain no path. A registered record becomes selectable
only when its normalized name matches a discovered directory basename or when a
valid absolute directory is explicitly present as its description. Unresolved
records remain visible and disabled with `directory unavailable` instead of
guessing a path.

Selecting a project:

1. aborts any active turn only after an explicit Ctrl+C; palette selection is
   disabled while a turn is running;
2. changes the process working directory;
3. emits OSC 7 for terminal/file-tree integrations;
4. rebuilds the Agent using the active model;
5. creates a fresh session and refreshes the file index.

Files and folders are indexed asynchronously under the active project. The
walker skips `.git`, `node_modules`, `.next`, common build outputs, and hidden
cache directories. Results are bounded and sorted, with recently matched and
shorter paths first. A selected path replaces the active `@query` token with an
`@relative/path` reference. Paths containing whitespace use `@"relative path"`.
No file content is read before the message reaches the Agent.

## Model Profiles and Persistence

Model candidates merge:

1. profiles from readable Desktop settings databases;
2. the current environment model;
3. a `Manual provider/model` action.

Desktop databases are opened read-only through a small adapter. Database lookup
checks known development and packaged application data locations and validates
the `settings` schema. A missing database, native SQLite incompatibility, lock,
or malformed profile is a non-fatal warning; environment and manual models stay
available.

The TUI persists its selected default to
`~/.customer-agent-tui/config.json` with mode `0600`. For a Desktop profile it
stores the source/profile ID plus non-secret display fields and resolves the API
key from Desktop on startup. For a manual model it stores provider, model ID, and
base URL but continues to obtain the API key from `AGENT_API_KEY`; it never adds
a plaintext manually entered secret to the TUI config.

Startup resolution order is:

1. persisted TUI profile, if it can still resolve credentials;
2. current Desktop active profile;
3. `AGENT_MODEL_*` environment variables.

Selecting a model rebuilds the Agent while preserving the active working
directory and starts a new session to keep usage metadata and model context
consistent. Invalid provider/model syntax or missing credentials leaves the
current Agent unchanged and displays an actionable error.

## Rendering and Turn Flow

The runtime converts each `agent.run()` event into transcript state:

- `thinking` updates the current progress label immediately;
- `text_chunk` appends to one assistant entry;
- `tool_call` and `tool_result` append durable transcript rows;
- `done` freezes elapsed time and token usage;
- `turn_aborted` and `error` terminate progress without losing prior rows.

The first progress state is set synchronously before iteration begins, preserving
the previous first-event latency fix. Skill candidates come from the already
built registry; opening `/` never invokes semantic skill matching or a model.

While a turn is running, normal submission and palettes are disabled. Ctrl+C
aborts the Agent; a second Ctrl+C while idle exits. `ask_user` switches the
composer into question mode and returns the submitted answer to the tool callback.

## Error Handling

- Filesystem permission errors remove only the affected candidate subtree and
  surface a compact warning.
- Project or model rebuild failure keeps the previous runtime active.
- Missing Desktop/Server databases do not block startup.
- An empty candidate set shows `No matches` without changing input.
- Non-interactive stdin reports that the Ink TUI requires a terminal and exits
  cleanly.
- Terminal resize changes the palette viewport but not the current selection.

## Testing

Unit tests cover:

- slash detection, filtering, exact built-in dispatch, skill pass-through, and
  unknown slash pass-through;
- at-token detection, quoting, project deduplication/resolution, ignored
  directories, and bounded indexing;
- model source precedence, safe persistence, malformed config/database fallback,
  and runtime rollback after rebuild failure;
- composer reducer behavior for arrows, Enter, Esc, backspace, cursor movement,
  and Ctrl+C;
- event-to-transcript reduction for thinking, streaming text, tools, completion,
  errors, and aborts.

Ink integration tests cover palette rendering, secondary `/model` and `/open`
flows, inline questions, and stable transcript rendering during a streamed turn.

Manual PTY verification covers:

1. `/` lists commands and real discovered skills without network activity;
2. a selected skill reaches the Agent;
3. `@` switches projects and inserts file/folder references;
4. `/model` switches a Desktop profile and survives restart;
5. thinking and tool activity remain visible before the final response;
6. Ctrl+C, terminal resize, Unicode input, and long candidate lists behave
   correctly.

## Out of Scope

- Previewing or attaching file contents inside the palette;
- editing Desktop model profiles from the TUI;
- writing paths back into the current SQLite project schema;
- mouse interaction, split panes, or a full-screen file browser;
- changing the Agent's tool or skill discovery semantics beyond explicit slash
  pass-through.
