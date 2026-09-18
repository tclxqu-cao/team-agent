import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logged: Array<{ level: string; message: string; error?: unknown; data?: unknown }> = [];

vi.mock("../../../lib/global-logger", () => ({
  serverLogger: () => ({
    log: (level: string, message: string, error?: unknown, data?: unknown) => {
      logged.push({ level, message, error, data });
    },
  }),
}));

import { POST } from "./route";

function post(body: unknown, ip = "203.0.113.10"): Promise<Response> {
  return POST(new Request("http://localhost/api/client-logs", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  logged.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/client-logs", () => {
  it("accepts a single error entry and records it with client metadata", async () => {
    const res = await post({
      level: "error",
      message: "TypeError: x is not a function",
      source: "webapp",
      error: { name: "TypeError", message: "x is not a function", stack: "stack…" },
      data: { route: "/web" },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { accepted: number };
    expect(json.accepted).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe("error");
    expect(logged[0].message).toBe("TypeError: x is not a function");
    expect((logged[0].data as { clientIp?: string }).clientIp).toBe("203.0.113.10");
    expect((logged[0].data as { clientSource?: string }).clientSource).toBe("webapp");
  });

  it("accepts batched entries up to the cap and clamps disallowed levels", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ level: "info", message: `m${i}` }));
    const res = await post({ entries });
    const json = await res.json() as { accepted: number };
    expect(json.accepted).toBe(20);
    // "info" is clamped to "error" — client reporting is for problems only.
    expect(logged.every((entry) => entry.level === "error")).toBe(true);
  });

  it("keeps warn and fatal levels, drops entries without a message", async () => {
    const res = await post({
      entries: [
        { level: "warn", message: "slow request" },
        { level: "fatal", message: "renderer gone", error: { name: "RenderGone", message: "oom" } },
        { message: "" },
        { level: "error" },
      ],
    });
    const json = await res.json() as { accepted: number };
    expect(json.accepted).toBe(2);
    expect(logged.map((entry) => entry.level)).toEqual(["warn", "fatal"]);
    expect(logged[1].error).toMatchObject({ name: "RenderGone", message: "oom" });
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await POST(new Request("http://localhost/api/client-logs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: "{broken",
    }));
    expect(res.status).toBe(400);
    expect(logged).toHaveLength(0);
  });

  it("rate limits per client IP with 429", async () => {
    const ip = "203.0.113.99";
    let lastStatus = 200;
    for (let i = 0; i < 61; i++) {
      lastStatus = (await post({ message: `spam ${i}` }, ip)).status;
    }
    expect(lastStatus).toBe(429);
  });

  it("drops oversized data payloads instead of throwing", async () => {
    const big = { blob: "x".repeat(5000) };
    const res = await post({ message: "with big data", data: big });
    const json = await res.json() as { accepted: number };
    expect(json.accepted).toBe(1);
    expect((logged[0].data as { data?: unknown }).data).toBeUndefined();
  });
});
