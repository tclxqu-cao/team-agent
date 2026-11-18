/** The initial read supplies the first snapshot; poll only after it has settled. */
export function startSessionHistoryPolling(refresh: () => void, ready: () => boolean): () => void {
  const timer = globalThis.setInterval(() => {
    if (ready()) refresh();
  }, 2_000);
  return () => globalThis.clearInterval(timer);
}

/** Resume after the initial read settles, including when only the Shell frame changed. */
export function refreshSessionHistoryWhenReady(refresh: () => void, ready: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    if (ready()) refresh();
    else timer = globalThis.setTimeout(attempt, 50);
  };
  attempt();
  return () => globalThis.clearTimeout(timer);
}
