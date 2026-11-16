import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

describe("retired messaging feature", () => {
  it.each([GET, POST])("rejects legacy clients without starting collection or delivery", async handler => {
    const response = handler();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "消息接入功能已移除" });
  });
});
