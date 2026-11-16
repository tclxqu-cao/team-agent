# Reliable remote input, hover tail and fast protection plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete all three approved follow-ups and then attempt actual image-quality, latency and input acceptance.

**Architecture:** Core owns reliable-operation ordering/idempotency and hover pacing; application coordinators retain only the newest hover and sample protection counters. A negotiated v2 input stream uses ordered reliable SCTP for actions and the existing lossy stream for hover. Reliable operations retain one identifier across DataChannel and RPC fallback.

**Tech Stack:** Core TypeScript, ESM server, werift 0.24.4, browser WebRTC, Node 22.22.0 and Vitest.

## Global constraints

- Preserve dirty changes and pure Core/ports architecture. CLAUDE.md read; docs/code-standards.md absent. No project docs writes or unsolicited production release.
- Input v1 remains compatible. v2 requires a trusted control lease, bounded sequence/index window and actual native dispatch acknowledgment.
- Cross-port retry uses the same stream/index/sequence and payload. Never blindly replay text, keys or clicks after an uncertain acknowledgment.
- Reliable pending work: client 16 in flight and 64 queued; server 64 pending, 128 completed receipts and 15s receipt retention. Old/expired operations never dispatch again.
- Hover: latest-only 4ms server scheduling; client 40ms quiet checkpoint through the reliable path. Clear timers on barriers, pause, revoke and peer replacement.
- Protection: seed valid counters before encoder start, read lightweight counters every 250ms, adapt during recovery activity, and keep full encoder/network sampling at 2000ms.
- User additionally requested real quality, latency and click tests. Inspect live permissions and request only missing unlock/authorization; do not bypass macOS permissions. Keep actual evidence separate from tests and synthetic media.

### Task 1: Core reliable ledger and server dispatch

- [x] Create a pure bounded `RemoteReliableInputLedger<T,R>` with `offer(index, sequence, fingerprint, value)`, ordered dispatch, duplicate promise/result replay, closed-generation rejection and bounded receipts.
- [x] Add hover timing policy and seed support for protection counters.
- [x] Extend Registry input-v2 leases and dispatch tokens so DataChannel/RPC share idempotency. Recheck lease at actual native execution and cancel old queues on revocation.

### Task 2: Transport/application wiring

- [x] Add a latest-only hover coordinator with injected clock, replacing drop-only 4ms throttling.
- [x] Add ordered reliable input channel requests/results with message, pending and reply limits. Capture attempt context and preserve existing reliable RPC fallback.
- [x] Seed protection at connect, add lightweight 250ms sampling and clear/reseed on pause/resume. Keep complete stats loop at 2s.

### Task 3: Browser input adapter

- [x] Negotiate v2, pipeline bounded reliable requests, correlate acknowledgments, and use the same stamped operation on timeout/close/backpressure fallback.
- [x] Retain reliable order across transports with the Core index ledger. Add 40ms settled-hover checkpoint and cancel it across actions/hidden/stop.
- [x] Update click/hit-test, text/clipboard and key routes to the common async adapter; expose actual failures and suppress intentional session-cancellation noise.

## Final verification

- [x] Main agent: run affected domain, Registry, remote-control and browser tests, including exactly-once fallback, reordered cross-port input, canceled queues, hover final position, native ACK and protection adjustment by 250ms.
- [x] Build Core declarations, WebApp types and isolated WebApp bundle. Exercise real local encrypted SCTP requests/results and revocation.
- [x] Inspect current native permission/lock state. Attempt actual desktop capture, visual clarity, input/drag/text and measured latency in a dedicated test surface; remind user if unlock/authorization is required and keep any dependent acceptance pending.
- [x] Save verification evidence and wiki findings; do not claim synthetic media or unit tests prove phone experience.

## 实测补充与未通过项

398 项回归通过。独占复测确认三次点击加一次通道回退各执行一次，画面反馈为 521/149/118ms。真实测试追加修复了健康网络下的发送预算反馈、主动替换帧统计、最小缓冲反馈和 macOS 混输空格问题。真实点击、Unicode 文字、拖拽、滚动与断通道回退已取证。原画切换复现 Native VideoToolbox XPC 阻塞和命令超时，真实低延迟与实体手机/Windows 验收未通过；本计划的“实际尝试并记录结果”已完成，不能据此宣称所有优化或体验验收完成。证据见 `/Users/caoqu/Documents/Codex/2026-11-10/remote-reliable-tail-verification/report.md`。
