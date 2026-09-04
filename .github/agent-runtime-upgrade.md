# Agent Runtime Upgrade Automation

AgentRoam tracks only the stable npm `latest` tags for Codex, Claude Agent SDK,
and the matching OpenCode CLI/SDK pair. The daily discovery workflow processes
one Agent at a time in the fixed order Codex, Claude, OpenCode. It reserves the
next existing `X.Y.Z-preview.N` series number, applies deterministic version
changes, and opens a same-repository candidate PR plus a tracking issue.

## Required Repository Configuration

Create these GitHub Environments. Do not reuse credentials between them:

| Environment | Secrets |
| --- | --- |
| `agent-runtime-smoke-codex` | `PROVIDER_API_KEY` |
| `agent-runtime-smoke-claude` | `PROVIDER_API_KEY` |
| `agent-runtime-smoke-opencode` | `PROVIDER_API_KEY`, `OPENCODE_CONFIG_JSON` |
| `agent-runtime-repair` | `OPENAI_API_KEY` |
| `agent-runtime-publish-npm` | `NPM_TOKEN` |
| `agent-runtime-publish-gitee` | `GITEE_TOKEN` |

`OPENCODE_CONFIG_JSON` must select the isolated smoke account's provider and
model. The workflow maps that Environment's `PROVIDER_API_KEY` to
`OPENCODE_API_KEY` for the isolated OpenCode process.

Allow GitHub Actions to create pull requests. Protect the default branch with
the required check `agent-runtime-candidate-check`. Create these labels:

- `automation`
- `agent-runtime-upgrade`
- `agent-runtime-active`
- `agent-runtime-candidate`
- `agent-runtime-soak`
- `agent-runtime-codex`
- `agent-runtime-claude`
- `agent-runtime-opencode`
- `agent-runtime-repair`
- `needs-human`
- `promotion-hold`

The Gitee repository must be configured as the `gitee` Git remote in publish
jobs. Authentication belongs in runner credential configuration, never in the
remote URL. Gitee Releases are the canonical installer download location.

## Release Controls

Candidate artifacts are published under npm `preview`. A candidate remains the
only active upgrade during its 24-hour macOS and Windows soak. Promotion moves
the same seven immutable package versions to `latest`; it never republishes.

- Run `agent-runtime-upgrade` manually to trigger discovery.
- Add `promotion-hold` to the tracking issue to block promotion.
- Dispatch `agent-runtime-soak` to run an immediate qualifying check.
- Dispatch the publish workflow's rollback mode to restore `preview` or
  `latest` to an explicit prior version.

Local emergency release commands use `scripts/publish-agentroam-release.mjs`.
They require local npm/Gitee credentials and are intentionally separate from
CI's environment-scoped tokens. Always run `preflight` and a `--dry-run` mode
before any emergency write.
