# Harness message order repair

Goal: Keep DeepSeek Harness reasoning, text and tools in execution order during history recovery, without changing other agents.

- [x] Retain native source metadata as an internal name for Harness-injected user context, so it cannot end the run's user turn.
- [x] Enable ordered reconciliation only for Harness in addition to existing agents, and reset its projected assistant group at text completion and tool results.
- [x] Cover complete history, missing tools, live reasoning identities, multiple steps, later user input and legacy messages in focused tests.
- [x] Replay the reported session read-only and compare other agents' projections before/after.
- [x] Run affected runtime and renderer history tests; review the diff and capture findings in wiki.

Constraints: No shared renderer behavior changes, prompts, service restarts, deployment, commit or push. Project docs/code-standards.md is absent. Project CLAUDE.md architecture rules apply. Use the project's lightweight bug-fix workflow; do not create project docs.

Verification: 257 relevant tests passed (254 in the six-file regression, followed by the expanded 15-case Harness file). Native-runtime TypeScript check and an isolated Bun bundle passed. Six real-session replay combinations preserved the four completed operations before the later text and remained idempotent. All 21 before/after projection fixtures across seven other agents were identical. The shared runtime was not restarted; the :3000 process has not loaded this change.
