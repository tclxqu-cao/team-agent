# Portfolio Project Skills Design

## Goal

Make `/Users/caoqu/team-agent/customer-agent/.agent/skills/portfolio-*/SKILL.md` the only authored source for the personal homepage Skills. Remove the TypeScript Skill prompt/list defaults.

## Architecture

The server resolves the repository Skill directory from `PORTFOLIO_SKILLS_DIR` or the server package location, then uses `SkillLoader` to discover and load every `portfolio-*` Skill. `Portfolio Content Agent.enabledSkills` is synchronized from the discovered names, so adding or removing a Skill is a file operation rather than a code-list change.

Portfolio sessions use the public Wiki as their working directory, so shared run configuration explicitly adds the repository Skill directory for this Agent. Explicit `/api/agent/run` validation loads the requested Portfolio Skill from the same file catalog. Legacy SQLite `portfolio-*` rows are ignored for this Agent and cannot override file-backed prompts.

## Error Handling

- Fail the Portfolio run with a clear error when the project Skill directory contains no valid `portfolio-*` Skills.
- Reject a requested Skill that is absent from the discovered file catalog or is not in the Agent allowlist.
- Keep normal Agent and SQLite Skill behavior unchanged.

## Verification

- Unit-test discovery, missing-directory failure, Agent creation, and existing-Agent allowlist synchronization.
- Unit-test that Portfolio runs attach the project Skill directory and do not register legacy SQLite Portfolio rows.
- Run the focused server tests, TypeScript build, and one real `portfolio-help` Agent run after restarting the service.
