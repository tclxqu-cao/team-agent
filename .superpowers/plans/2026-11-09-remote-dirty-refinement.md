# Remote dirty refinement and demand-only repair

Implement directly without subagents. Preserve all previous work; ordinary Git, no deploy/install/restart/shared dist writes.

Goal: remove false dirty invalidations on Mac and redundant native scans on both platforms, then validate the actual native capture pipeline when screen permission/unlock is available.

- [x] Bound exact BGRA dirty-tile comparisons to 2 ms and supported frame limits; compare successive capture buffers, conserve immutable encoder versions, use conservative dirty invalidation on unsupported geometry/time budget. Only actual changes clear overlays; retain correct scroll revision.
- [x] Core chooses unresolved blocks excluding in-flight placements; application skips samples when there is no available debt while maintaining timeout/control/QoE handling. Native adapters accept optional selected-only indices with legacy fallbacks; cap inputs and scanning.
- [x] Regression tests: false dirty, sparse actual change, stale submitted frame, dimension/geometry/fallback, selected-only empty/edge blocks, full ACK sleep then new damage wakes, in-flight exclusion, idle high-entropy retry.
- [x] Isolated Mac helper build/native self-tests, affected Vitest tests, Windows cross-build, focused TS and adapter build/composition. Compare native scan work with previous baseline.
- [ ] Real ScreenCaptureKit -> VideoToolbox -> werift -> ego-browser verification with static/text/scroll content and presentation/ACK counters; report exact permission/platform boundary if unavailable. Do not substitute captureStream for native acceptance.
- [x] Review owned diff, save durable evidence and capture reusable findings to wiki. No project docs changes.

## Results (2026-11-10)

- 33 files / 326 Vitest cases pass; Mac build and seven native self-tests pass; Windows x64 cross-build, focused strict TS, isolated builds and Node22 composition pass.
- Source changes span ten files; the delta against the start-of-request snapshot is saved, unrelated dirty work is preserved.
- Actual native IPC capture was attempted twice from the new Mac helper and ego-browser task104. The OS reports screen=false and locked=true, and rejects capture with 请先授予屏幕录制权限. Real ScreenCaptureKit/VT/browser performance acceptance remains unchecked, awaiting unlock and permission. No synthetic video substitution.
- No installed helper replacement, :3000 restart, deployment, commit or push. The isolated test harness remains available for the pending user action.
- Evidence: /Users/caoqu/Documents/Codex/2026-11-10/remote-dirty-refinement-verification/manifest.json.
