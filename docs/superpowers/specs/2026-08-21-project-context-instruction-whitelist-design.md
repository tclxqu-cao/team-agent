# Project Context Instruction Whitelist Design

## Context

`ContextLoader` currently loads a fixed set of project files from the configured working directory and recursively discovers only `CLAUDE.md`. As a result, `AGENTS.md` rules are omitted, and Customer Agent-specific context under the project-local `.customer-agent/` directory cannot enter the model context.

## Goals

- Load `AGENTS.md` alongside the existing root project context files.
- Load an explicit context-file whitelist from the root `.customer-agent/` directory.
- Discover both `CLAUDE.md` and `AGENTS.md` in project subdirectories.
- Keep discovery deterministic, bounded, and tolerant of missing or unreadable files.
- Prevent arbitrary Markdown files from entering the model context.

## Non-goals

- No user-configurable glob patterns.
- No scan of every Markdown file under `.customer-agent/`.
- No parent-directory or home-directory discovery. An exact fixed-whitelist path may be a symbolic link and is treated as explicit project authorization for its target.
- No change to context token allocation or prompt assembly.

## Discovery Rules

The configured working directory remains the context root.

### Project root whitelist

Load these paths in order when present:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `README.md`
4. `CONTRIBUTING.md`
5. `.cursorrules`
6. `.github/copilot-instructions.md`

### `.customer-agent/` whitelist

Load the same fixed paths relative to `<root>/.customer-agent/`:

1. `.customer-agent/AGENTS.md`
2. `.customer-agent/CLAUDE.md`
3. `.customer-agent/README.md`
4. `.customer-agent/CONTRIBUTING.md`
5. `.customer-agent/.cursorrules`
6. `.customer-agent/.github/copilot-instructions.md`

Files outside this list are ignored even when they use the `.md` extension.

An exact whitelist entry may be a symbolic link. This is required for repositories that intentionally link root `AGENTS.md` to a shared rules file; the whitelisted link path remains the context identity shown to the model.

### Recursive instruction discovery

After the two ordered whitelist passes, recursively discover regular files named `AGENTS.md` or `CLAUDE.md` below the project root. Ignore symbolic links during recursive discovery, skip files already loaded by either whitelist, and continue excluding `node_modules`, `.git`, and `dist` directories. Return discovered files in stable lexical path order so prompt composition is deterministic across filesystems.

## File Classification

- `AGENTS.md` and `CLAUDE.md` use the existing instruction-file context type.
- `README.md` and `CONTRIBUTING.md` remain readme context.
- Other whitelisted Markdown paths remain config context.

No public interface change is required unless the existing `ProjectFile` type needs a clearer shared instruction classification.

## Error Handling

Missing, unreadable, or transiently removed files are skipped without failing the Agent run, matching current behavior. Directory traversal failures are isolated to the inaccessible subtree.

## Testing

Add focused `ContextLoader` tests using a temporary directory:

- loads all root whitelist files in the specified order;
- loads all `.customer-agent/` whitelist files after root files;
- recursively discovers nested `AGENTS.md` and `CLAUDE.md` in stable order;
- does not duplicate root or `.customer-agent/` instruction files;
- follows an exact whitelisted instruction symlink while preserving its whitelisted path;
- ignores recursively discovered instruction symlinks;
- ignores arbitrary Markdown files and excluded directories;
- tolerates absent optional files.

Run the focused context tests and the full core test suite. Existing `ContextAssembler` behavior must remain unchanged.
