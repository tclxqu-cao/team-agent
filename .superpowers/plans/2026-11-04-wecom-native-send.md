# Local WeCom Sending Implementation Plan

> **For the main agent:** Implement directly in this session without subagents. Run affected tests after development and fix failures before reporting completion.

**Goal:** Complete the authorized single-message test through the original local WeCom client, then expose the accepted accessibility bridge to AgentRoam without wecom-cli.

**Architecture:** A separately signed helper controls the original client using macOS accessibility. A local controller validates conversation identity against the receiver mirror, persists an idempotency ledger before submission, and verifies an outgoing native record. The messaging adapter preserves unknown-result semantics.

**Tech Stack:** Swift/AppKit/ApplicationServices, Python standard library, existing TypeScript messaging runtime and SQLite receiver.

## Constraints

- Preserve the original WeCom app, login session and unrelated repository changes.
- Use the already authorized recipient/body once: 蔡正银（zhengyin.cai）, 本地接口发送测试.
- Validate both the selected row and actual chat header before entering or submitting text; preserve existing drafts.
- Persist submission intent before Return. Interrupted or unverified submissions remain unknown and must never retry automatically.
- Do not bypass native confirmation, permissions, anti-abuse controls, or erase records.
- No commit, push, npm publish, or unrelated service restart.

## Tasks

- [x] Support direct-chat static headers and atomic row identity checks in the helper; verify actual granted permissions after installation.
- [x] Select and verify the authorized conversation, prepare the exact body, submit once and collect a compact receipt from the receiver mirror.
- [x] Add a reusable controller, bounded receipt checks and a minimal delivery adapter; add all required runtime assets to the staging workflow.
- [x] Run focused wrong-target, draft, unknown-result, idempotency and adapter regression tests.
- [x] Record the actual outcome and constraints in the existing research artifact and wiki capture.

## Acceptance

- Native outgoing record: 2026-11-04 23:04:41 Asia/Shanghai, RID 4478875, seq 14520352, flag 0. One actual submission.
- Confirmed-id replay through both Python and the TypeScript adapter returned the same receipt without UI operations.
- 40 TypeScript tests, 21 Python tests and 2 native inventory tests passed. Strict TypeScript check, Swift compilation and helper signature validation passed.
- Standalone sender is installed and usable. The existing :3000 production gateway remains unchanged because other tasks are active; its new adapter wiring is pending a gateway rebuild/reload. No npm release, commit or push.
