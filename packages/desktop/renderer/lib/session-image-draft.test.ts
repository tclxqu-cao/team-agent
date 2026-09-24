import { describe, expect, it } from "vitest";
import {
  IndexedDbSessionImageDraftRepository,
  SessionImageDraftCoordinator,
  type SessionImageDraftRepository,
} from "./session-image-draft";

const IMAGE_A = "data:image/png;base64,YQ==";
const IMAGE_B = "data:image/jpeg;base64,Yg==";

class MemoryImageDraftRepository implements SessionImageDraftRepository {
  readonly values = new Map<string, string[]>();

  async read(sessionId: string): Promise<string[]> {
    return [...(this.values.get(sessionId) ?? [])];
  }

  async write(sessionId: string, images: string[]): Promise<void> {
    if (images.length === 0) this.values.delete(sessionId);
    else this.values.set(sessionId, [...images]);
  }

  async clear(sessionId: string): Promise<void> {
    this.values.delete(sessionId);
  }
}

describe("session image drafts", () => {
  it("falls back safely when IndexedDB is unavailable", async () => {
    const repository = new IndexedDbSessionImageDraftRepository(null);

    await expect(repository.write("session-a", [IMAGE_A])).resolves.toBeUndefined();
    await expect(repository.read("session-a")).resolves.toEqual([]);
    await expect(repository.clear("session-a")).resolves.toBeUndefined();
  });

  it("keeps images isolated and restores them with a new coordinator after refresh", async () => {
    const repository = new MemoryImageDraftRepository();
    const firstPage = new SessionImageDraftCoordinator(repository);
    await firstPage.save("session-a", [IMAGE_A]);
    await firstPage.save("session-b", [IMAGE_B]);

    const refreshedPage = new SessionImageDraftCoordinator(repository);
    await expect(refreshedPage.restore("session-a")).resolves.toEqual({
      sessionId: "session-a",
      images: [IMAGE_A],
    });
    await expect(refreshedPage.restore("session-b")).resolves.toEqual({
      sessionId: "session-b",
      images: [IMAGE_B],
    });
  });

  it("does not let a stale read overwrite the newly selected session", async () => {
    let resolveSessionA: ((images: string[]) => void) | undefined;
    const repository: SessionImageDraftRepository = {
      read: (sessionId) => sessionId === "session-a"
        ? new Promise<string[]>((resolve) => { resolveSessionA = resolve; })
        : Promise.resolve([IMAGE_B]),
      write: async () => undefined,
      clear: async () => undefined,
    };
    const coordinator = new SessionImageDraftCoordinator(repository);

    const staleSessionA = coordinator.restore("session-a");
    const selectedSessionB = coordinator.restore("session-b");
    resolveSessionA?.([IMAGE_A]);

    await expect(selectedSessionB).resolves.toEqual({ sessionId: "session-b", images: [IMAGE_B] });
    await expect(staleSessionA).resolves.toBeNull();
  });

  it("writes only to the selected session and clears only the requested session", async () => {
    const repository = new MemoryImageDraftRepository();
    repository.values.set("session-a", [IMAGE_A]);
    repository.values.set("session-b", [IMAGE_B]);
    const coordinator = new SessionImageDraftCoordinator(repository);

    await coordinator.restore("session-a");
    await coordinator.saveSelected("session-b", [IMAGE_A]);
    await coordinator.clear("session-a");

    await expect(repository.read("session-a")).resolves.toEqual([]);
    await expect(repository.read("session-b")).resolves.toEqual([IMAGE_B]);
  });
});
