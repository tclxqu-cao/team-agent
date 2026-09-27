import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("flow-studio config route", () => {
  const original = process.env.AGENT_FLOW_STUDIO_ENTRY_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_FLOW_STUDIO_ENTRY_URL;
    else process.env.AGENT_FLOW_STUDIO_ENTRY_URL = original;
  });

  it("returns the configured entry url verbatim", async () => {
    process.env.AGENT_FLOW_STUDIO_ENTRY_URL = "http://127.0.0.1:8901/auth/entry?token=t&view=dh";
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      entryUrl: "http://127.0.0.1:8901/auth/entry?token=t&view=dh",
    });
  });

  it("returns null when unset, unparsable, or not http(s)", async () => {
    delete process.env.AGENT_FLOW_STUDIO_ENTRY_URL;
    await expect((await GET()).json()).resolves.toEqual({ entryUrl: null });
    process.env.AGENT_FLOW_STUDIO_ENTRY_URL = "not a url";
    await expect((await GET()).json()).resolves.toEqual({ entryUrl: null });
    process.env.AGENT_FLOW_STUDIO_ENTRY_URL = "ftp://127.0.0.1:8901/x";
    await expect((await GET()).json()).resolves.toEqual({ entryUrl: null });
  });
});
