import { createConnection } from "node:net";
import WebSocket from "ws";

export type DesktopActivity =
  | { state: "idle" }
  | { state: "busy"; activeCount: number }
  | { state: "unknown"; reason: string };

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export class DesktopProbeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Read live state only. Never resume, subscribe, interrupt or unload a thread. */
export async function probeDesktopActivity(endpoint: string, timeoutMs = 5_000): Promise<DesktopActivity> {
  try {
    return await withDesktopRpc(endpoint, async (request, becameActive) => {
      const activity = await readDesktopActivity(request);
      return becameActive() && activity.state === "idle" ? { state: "busy", activeCount: 1 } : activity;
    }, timeoutMs);
  } catch {
    return { state: "unknown", reason: "无法完整查询桌面端的实时任务状态" };
  }
}

export async function withDesktopRpc<T>(endpoint: string,
  operation: (request: Request, becameActive: () => boolean) => Promise<T>, timeoutMs = 5_000): Promise<T> {
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPending: (() => void) | undefined;
  try {
    const address = new URL(endpoint);
    let url = endpoint;
    let socketPath: string | undefined;
    if (address.protocol === "ws+unix:") {
      const separator = address.pathname.indexOf(":");
      if (address.hostname !== "localhost" || separator < 1) throw new Error("invalid local socket");
      socketPath = decodeURIComponent(address.pathname.slice(0, separator));
      url = `ws://localhost${address.pathname.slice(separator + 1)}`;
    } else if (!(["ws:", "wss:"].includes(address.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname))) {
      throw new Error("not a local Desktop endpoint");
    }
    if (address.username || address.password || address.search || address.hash) throw new Error("invalid endpoint");
    socket = new WebSocket(url, {
      ...(socketPath ? { createConnection: () => createConnection({ path: socketPath }) } : {}),
      handshakeTimeout: timeoutMs,
      // Older Codex backends reject a Sec-WebSocket-Extensions offer.
      perMessageDeflate: false,
    });
    const connection = socket;
    let nextId = 0;
    let changedToActive = false;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const fail = (error = new Error("Desktop probe disconnected")) => {
      for (const item of pending.values()) item.reject(error);
      pending.clear();
    };
    rejectPending = fail;
    const opened = new Promise<void>((resolve, reject) => {
      connection.once("open", () => resolve());
      connection.once("error", (error) => reject(new Error(`Desktop probe connection failed: ${error.message}`, { cause: error })));
      connection.once("close", () => reject(new Error("Desktop probe disconnected")));
    });
    connection.on("error", fail);
    connection.on("close", () => fail());
    connection.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.method === "thread/status/changed" && message.params?.status?.type === "active") changedToActive = true;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        if (message.error) item.reject(new DesktopProbeRpcError(message.error.code, String(message.error.message ?? "Desktop probe RPC failed")));
        else item.resolve(message.result);
      } catch {
        fail();
      }
    });
    const request: Request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { connection.send(JSON.stringify({ id, method, params })); }
      catch (error) { pending.delete(id); reject(error); }
    });
    const run = async (): Promise<T> => {
      await opened;
      await request("initialize", { clientInfo: { name: "agentroam_desktop_setup", version: "1" }, capabilities: { experimentalApi: true } });
      connection.send(JSON.stringify({ method: "initialized", params: {} }));
      return operation(request, () => changedToActive);
    };
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Desktop probe timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    rejectPending?.();
    socket?.terminate();
  }
}

export async function readDesktopActivity(request: Request): Promise<DesktopActivity> {
  const listLoaded = async (): Promise<string[]> => {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await request("thread/loaded/list", { cursor, limit: 100 }) as { data?: unknown; nextCursor?: unknown };
      if (!Array.isArray(page?.data) || page.data.some((id) => typeof id !== "string" || !id)) throw new Error("incomplete loaded thread list");
      for (const id of page.data) ids.add(id);
      if (page.nextCursor === null || page.nextCursor === undefined) return [...ids].sort();
      if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor)) throw new Error("invalid cursor");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("Desktop thread list exceeded probe limit");
  };
  const ids = await listLoaded();
  let activeCount = 0;
  let hasUnknownStatus = false;
  for (const threadId of ids) {
    const result = await request("thread/read", { threadId, includeTurns: false }) as { thread?: { id?: string; status?: { type?: string } } };
    if (result?.thread?.id !== threadId) throw new Error("Desktop thread identity changed");
    const status = result.thread.status?.type;
    if (status === "active") activeCount++;
    else if (status !== "idle") hasUnknownStatus = true;
  }
  if (activeCount) return { state: "busy", activeCount };
  if (hasUnknownStatus || JSON.stringify(ids) !== JSON.stringify(await listLoaded())) {
    return { state: "unknown", reason: "桌面任务列表发生变化或包含无法确认的状态" };
  }
  return { state: "idle" };
}
