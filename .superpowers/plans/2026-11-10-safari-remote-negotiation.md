# Safari High to Baseline negotiation isolation

Goal: repair the actual 19:03 phone failure: High rejected, then Baseline answer fails on a stale ICE usernameFragment; zero media sent on all retries.

Use existing approved fallback architecture. Preserve DDD: session application owns attempt identity, werift adapter owns SDP/candidate handling, browser presentation owns peer lifecycle. No native rebuild, no user auth changes, no project docs or unrelated source edits, no subagents or Git push.

- [x] Add a failing real-werift regression for pre-answer stale candidates; reproduce the exact error before implementation.
- [x] Tag each server transport attempt with a bounded identifier; echo on browser answer/ICE and ignore obsolete signals/callbacks.
- [x] Buffer candidates until the matching description is committed, bound queues, filter credentials for old clients, and emit offer before its trickled candidates.
- [x] Isolate browser negotiation coordination in a small presentation module, cancel old awaits and callbacks, and report a bounded negotiation error without raw SDP/IPs.
- [x] Test real High rejection to Baseline fallback including delayed ICE; verify actual H264 decoded frames using ego-browser and latest native component.
- [x] Build and activate latest WebApp/gateway on the original :3000 entry, verify health and keep real phone validation boundary explicit. Preserve old artifacts for rollback and capture findings in wiki.
