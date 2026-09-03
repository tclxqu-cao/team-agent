const SESSION_TRANSPORT_ERROR = /^(?:load failed|failed to fetch|network request failed|networkerror when attempting to fetch resource\.?|the network connection was lost\.?|fetch failed)$/i;

export interface SessionLoadRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export function isSessionTransportError(error: unknown): boolean {
  return error instanceof Error
    && error.name !== "AbortError"
    && SESSION_TRANSPORT_ERROR.test(error.message.trim());
}

export function describeSessionLoadError(error: unknown): string {
  if (isSessionTransportError(error)) {
    return "网络连接中断，会话加载失败，请重新加载";
  }
  return error instanceof Error ? error.message : "会话加载失败";
}

export async function loadSessionWithRetry<T>(
  load: () => Promise<T>,
  options: SessionLoadRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (attempt === maxAttempts || !isSessionTransportError(error)) throw error;
      await sleep(baseDelayMs * attempt);
    }
  }

  throw new Error("会话加载失败");
}
