# Native Session Live Follow Implementation Plan

1. Add optional runtime-adapter watch-path lookup and pass it through the unified/native runtime services.
2. Implement validated Codex and Claude transcript path lookup.
3. Add a reference-counted, debounced server monitor and a read-only session-change SSE route.
4. Add Web `observeSession` support and the shared renderer API type.
5. Add stable history identity and a tail-replacement merge helper.
6. Observe eligible external sessions in `ChatView`, with a visible-page two-second polling fallback.
7. Add focused tests and run type checks/regression tests.
