# Source Harness self-repair

This opt-in headless entry point runs the real core AgentBuilder in a child process. A separate stable supervisor detects a crash or lack of progress, asks a separate model process for a source patch, verifies it, and starts a new Harness process from a durable checkpoint. It does not replace an already running Web, Desktop or TUI instance.

## Automatic Agent companion (Codex CLI)

Source Desktop/server/TUI start the companion with their lifecycle. On an exception or 180 seconds without progress, it starts a persisted `codex exec --cd <customer-agent-source-root>` session. Codex reads the project, edits source directly and runs tests with its own configured model and login. Host model settings are not used. Startup/idle do not start a Codex task. Set `AGENT_HARNESS_AUTOSTART=0` to disable monitoring; `HARNESS_CODEX_BINARY` overrides CLI discovery.

The session uses `workspace-write` and `approval_policy="never"`; actions requiring additional permissions fail rather than waiting unattended. Project instructions remain enabled. A checkout-wide `.agent-data/codex-harness-repair.lock` allows one repair writer. If the daemon is killed before cleanup, inspect the PID in this file before removing a stale lock. Failed/timed-out sessions can leave partial edits, which are retained for review.

Evidence under `~/.customer-agent-harness/host-repairs/` includes the request, output tail, final response and `codex-session.json` with its resumable session ID. Public process status is under `~/.customer-agent-harness/services/` and `GET /api/agent/harness/status`. A successful CLI exit is not proof of a correct fix. Codex is instructed to preserve existing changes, avoid commits/deployments and not replay the business task; these are task instructions, not file-level enforcement. Running applications are not automatically restarted.

The standalone supervisor described below remains a separate legacy opt-in path. Automatic host repair no longer calls its model proposer or isolated candidate promotion pipeline.

## Cross-session quality monitoring

The companion now persists redacted run observations under `~/.customer-agent-harness/quality/<project-hash>/`. Desktop/server/TUI share this project store. The rolling window retains 500 runs, each with at most 200 events / approximately 128 KB of observations. Task and context previews are bounded; truncation is explicit. Images and hidden reasoning are not collected. Secret-pattern redaction is best effort, and these private files can still contain business data.

Built-in AgentLoop sends private per-request context composition, bounded message/section previews and explicit iteration-limit observations through an optional builder observer. These snapshots do not enter the public UI event stream. Hosts forward completed tool parameters/result hashes, previews, context usage, compaction, errors and finish events. Native runtimes only provide what their adapters emit; full private request-context coverage applies to the built-in loop. Collection begins with new runs, not retroactive reconstruction of old chats.

Exceptions, emitted errors, no-progress and repeated completed step cycles immediately start Codex diagnosis. A single-session proven defect can be repaired directly. Weaker signals (identical tool arguments AND results, rereads after compaction, repeated compaction, context pressure, duplicated section previews) aggregate across at least three distinct sessions in the same runtime/model cohort. Every 20 completed distinct sessions in a cohort also triggers a sampled quality review, even without rule findings. Repeated turns in one session do not inflate the session denominator. Rules flag hypotheses, not proven defects or unnecessary actions.

Persisted issue/runtime/model claims prevent duplicate diagnosis across owners and daemon restarts. Busy checkout writers defer another issue for 60 seconds. Interrupted claims and stale checkout locks remain for inspection to avoid blindly repeating partial code edits. Session records from exited daemon PIDs are marked interrupted. Evidence packets include affected-session rates, up to three representatives, up to two successful nonmatching examples and version/model cohorts; prompts stay bounded. Sampled absence is not proof that a problem is resolved.

Repair records include source fingerprints before/after Codex and remain `needs-observation` (or `failed`). Status exposes cohort rates, average tool steps and peak context ratios. `runtimeVersion` is the core module/bundle fingerprint captured when the host initializes the companion, distinct from source-at-capture fingerprints; it does not prove a live process loaded subsequent source edits. Host restart is needed to load rebuilt code. Cohort/task-mix differences prevent automatic causal or resolved judgments. Codex receives explicit instructions to verify shared causes and multiple cases before making design changes.

Read compact findings and repair follow-up in `GET /api/agent/harness/status` (`quality`), or the private service status JSON. Full run evidence remains under the project quality directory.

## Start

Prerequisites: macOS with `sandbox-exec`, Bun, Node 22, installed workspace dependencies and a Git checkout. `--init` discovers the local nvm Node 22.22.0 path; edit `nodeExecutable` if installed elsewhere. Run from the repository root:

```sh
bun scripts/harness/run.ts --init /absolute/path/harness.json
# Set AGENT_API_KEY and AGENT_MODEL in your existing shell/secret manager.
# Optional: AGENT_PROVIDER=openai|anthropic|deepseek, AGENT_BASE_URL.
bun scripts/harness/run.ts --config /absolute/path/harness.json \
  --cwd /absolute/business/project --task 'Your task'
```

The default editable files are `AgentLoop.ts` and `ContextCompactor.ts`. `allowedFiles` accepts up to 12 exact core `.ts` paths. Tests, checkpoint storage/contracts and tool permission rules are protected; scripts and dependencies cannot be repair targets. Keep the allowed set small enough for the 180000-character repair context budget. The proposer returns exact unique substring replacements and a deterministic reproducer, with no shell or write tools. An empty proposal means the model did not establish a repairable Harness defect.

Each run creates a private folder under `~/.customer-agent-harness/<run-id>/`: task, checkpoint, event tail, attempts, verification outputs, source worktrees, accepted/rejected version pointers and successful repair experience. Logs contain task/tool data; permissions are 0700/0600. Model environment credentials are not saved in configuration. Existing source and index are preserved: a temporary Git index snapshots only core, harness scripts and build/test metadata. Local detached commits are never pushed.

## Verification and promotion

1. A nonzero worker crash or no-progress timeout starts a bounded repair (default 2 attempts). Explicit model/API errors and max-iteration exhaustion pause instead of changing code.
2. The stable proposer produces a bounded edit proposal. The supervisor applies it in a detached worktree.
3. A macOS sandbox runs the existing agent/checkpoint regressions on the baseline, then the proposed reproducer on old/new code, then the same fixed regressions on the candidate. Old must fail, new must pass, and fixed regressions must pass. The reproducer and fixed Vitest config are read-only; each command gets a fresh writable scratch directory, no network, no model credentials, and cannot read unrelated user files or write source files.
4. The supervisor hashes the tree, seals a detached candidate commit, then starts a fresh worker. Completion requires a matching durable checkpoint and result receipt, not just exit code zero.
5. Once the original task completes, `accepted.json` is updated. Later supervised tasks use that accepted version. `--fresh-source` starts from the current checkout instead. Existing applications are not redeployed. If candidate recovery fails, the active pointer rolls back and execution pauses; external effects are never rolled back or blindly replayed.

Verification does not prove arbitrary model-generated code correct or business outcomes successful. The headless worker uses the existing built-in tools; it does not currently load Desktop model profiles, Desktop sessions or MCP connections. Set the model environment explicitly. Integration tests use deterministic local model responses, real processes/Git/sandbox and an injected source defect; real-model autonomous repair quality needs additional workload evaluation.

## Recovery

```sh
bun scripts/harness/run.ts --config /absolute/path/harness.json --resume RUN_ID
```

Checkpoints are stored before tool dispatch and after complete tool batches. A crash in a batch leaves `tools_pending`, even if some tools completed. Recovery refuses to repeat that batch. Inspect the external state, then supply one verified outcome for every pending call:

```json
[{"toolCallId":"call-id-from-checkpoint","content":"Verified actual outcome","isError":false}]
```

```sh
bun scripts/harness/run.ts --config /absolute/path/harness.json \
  --reconcile RUN_ID --results /absolute/verified-results.json
bun scripts/harness/run.ts --config /absolute/path/harness.json --resume RUN_ID
```

Unknown outcomes must remain pending. A schema/identity mismatch also fails closed; automatic schema migration is deliberately not attempted. Only one supervisor can own a state directory. A crash of the supervisor itself leaves `supervisor.lock`: establish that its PID is gone before manually removing it, then resume. Repair attempts are persisted before dispatch so interruption does not reset the budget. Worktrees/evidence are retained for review; use Git worktree removal when intentionally cleaning old runs, preserving the version referenced by `accepted.json`.

## Tests

```sh
node_modules/.bin/vitest run packages/core/src/domain/agent \
  packages/core/src/infrastructure/RunCheckpointStore.test.ts scripts/harness \
  --pool=forks --maxWorkers=1 --minWorkers=1 --no-file-parallelism
node_modules/.bin/tsc --noEmit -p packages/core/tsconfig.json
```
