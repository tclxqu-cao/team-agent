import { beforeEach, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/session-images", () => ({ getSessionImageStore: () => ({ read }) }));
import { GET } from "./route";
const id = "a".repeat(64);
beforeEach(() => { read.mockReset(); });

it("defaults to a preview and reads the original only for an explicit original request", async () => {
  read.mockResolvedValue("data:image/webp;base64,AQID");
  expect((await GET(new Request("http://localhost/api/session-images/" + id), { params: { id } })).status).toBe(200);
  expect(read).toHaveBeenLastCalledWith(id, "preview");
  await GET(new Request("http://localhost/api/session-images/" + id + "?variant=original"), { params: { id } });
  expect(read).toHaveBeenLastCalledWith(id, "original");
});

it("rejects paths and unsupported variants before opening any file", async () => {
  expect((await GET(new Request("http://localhost/api/session-images/test"), { params: { id: "../secret" } })).status).toBe(400);
  expect((await GET(new Request("http://localhost/api/session-images/" + id + "?variant=other"), { params: { id } })).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it("returns a recoverable error when the original has gone away", async () => {
  read.mockRejectedValue(new Error("missing"));
  const response = await GET(new Request("http://localhost/api/session-images/" + id + "?variant=original"), { params: { id } });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "原图加载失败，请重试或刷新会话" });
});
