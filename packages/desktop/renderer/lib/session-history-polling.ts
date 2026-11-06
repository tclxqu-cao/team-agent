/** The initial read supplies the first snapshot; poll only after it has settled. */
export function startSessionHistoryPolling(refresh: () => void, ready: () => boolean): () => void {
  const timer = globalThis.setInterval(() => {
    if (ready()) refresh();
  }, 2_000);
  return () => globalThis.clearInterval(timer);
}
