/** Thrown on HTTP 401 — the shell listens for it to show the login screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super("未登录或会话已过期");
    this.name = "UnauthorizedError";
  }
}

/** Domain-level transport error surfaced to the UI as-is. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
}

/**
 * Thin JSON fetch wrapper: same-origin cookies, unified error mapping,
 * and a global "webapp:unauthorized" event on 401 so the composition root
 * can swap to the login screen without every adapter caring.
 *
 * baseUrl is empty in the browser (same-origin relative paths) and set to the
 * remote AgentRoam server when running inside the mobile native shell, where
 * relative paths would hit the bundled capacitor://localhost document.
 */
export class HttpClient {
  constructor(
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    private baseUrl = "",
  ) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  private resolve(path: string): string {
    return this.baseUrl + path;
  }

  async get<T>(path: string, options?: HttpOptions): Promise<T> {
    return this.request<T>(path, { method: "GET", headers: options?.headers });
  }

  async post<T = unknown>(path: string, body?: unknown, options?: HttpOptions): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...options?.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async patch<T = unknown>(path: string, body?: unknown, options?: HttpOptions): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...options?.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async delete<T = unknown>(path: string, options?: HttpOptions): Promise<T> {
    return this.request<T>(path, { method: "DELETE", headers: options?.headers });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.transport(this.resolve(path), {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
    if (response.status === 401 || response.status === 423) {
      window.dispatchEvent(new CustomEvent("webapp:unauthorized"));
      throw new UnauthorizedError();
    }
    if (!response.ok) {
      let message = `请求失败 (${response.status})`;
      let code: string | undefined;
      try {
        const body = (await response.json()) as { error?: { message?: string } | string; code?: unknown };
        if (typeof body.error === "string") message = body.error;
        else if (body.error?.message) message = body.error.message;
        if (typeof body.code === "string") code = body.code;
      } catch { /* keep default message */ }
      throw new ApiError(response.status, message, code);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

/** Normalize `{items}|{entries}|{servers}|{skills}|[...]` style payloads. */
export function listOf<T>(payload: unknown, ...keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}
