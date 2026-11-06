import { describe, expect, it } from "vitest";
import type { ParallelConversation, UnifiedSessionSummary } from "../global";
import { ParallelFailedMessageRepository } from "./parallel-failed-messages";

describe("failed parallel message recovery", () => {
  function fixture() {
    const values = new Map<string, string>(), pictures = new Map<string, string[]>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const images = { read: async (key: string) => pictures.get(key) ?? [], write: async (key: string, value: string[]) => { pictures.set(key, value); }, clear: async (key: string) => { pictures.delete(key); } };
    const member = { id: "runtime:zcode:one", agentType: "zcode" } as UnifiedSessionSummary;
    const group = { id: "group", title: "question", cwd: "/repo", created: "now", members: [member] } as ParallelConversation;
    return { values, pictures, member, group, storage, images, repository: new ParallelFailedMessageRepository(storage, images) };
  }
  it("restores the same receipt and image payload after reload without putting image bytes in localStorage", async () => {
    const f = fixture();
    const failure = { member: f.member, message: { sourceMessageId: "receipt", content: "question", images: ["data:image/png;base64,fixture"] }, error: "offline" };
    await f.repository.write(f.group, [failure]);
    expect([...f.values.values()].join("")).not.toContain("data:image/");
    expect(await new ParallelFailedMessageRepository(f.storage, f.images).read(f.group)).toEqual([failure]);
    await f.repository.write(f.group, []);
    expect(await f.repository.read(f.group)).toEqual([]);
    expect(f.pictures.size).toBe(0);
  });
  it("prevents a retry from silently losing attachments that could not be restored", async () => {
    const f = fixture();
    await f.repository.write(f.group, [{ member: f.member, message: { sourceMessageId: "receipt", content: "question", images: ["image"] }, error: "offline" }]);
    f.pictures.clear();
    expect((await f.repository.read(f.group))[0]).toMatchObject({ blocked: true, error: expect.stringContaining("附件未恢复") });
  });
});
