import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionImageStore } from "./session-images";
import type { MessageAttachment } from "@agent/core";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-images-"));
  directories.push(directory);
  const compress = vi.fn(async () => Buffer.from("small-webp"));
  return { directory, compress, store: new SessionImageStore(join(directory, "cache"), compress) };
}

describe("session display image resources", () => {
  it("returns small identities without reading or compressing a native original on history load", async () => {
    const { directory, store, compress } = await fixture();
    const path = join(directory, "original.png");
    await writeFile(path, Buffer.alloc(900_000, 7));
    const detail = { messages: [{ role: "user", content: "image", presentation: {
      attachments: [{ type: "image" as const, name: "original.png", localImagePath: path }],
    } }] };
    const before = JSON.stringify(detail);
    const projected = await store.project(detail);
    expect(compress).not.toHaveBeenCalled();
    expect(JSON.stringify(projected).length).toBeLessThan(500);
    expect(JSON.stringify(projected)).not.toContain(directory);
    expect(JSON.stringify(detail)).toBe(before);
    const image = projected.messages[0].presentation.attachments[0] as MessageAttachment;
    expect(image).toMatchObject({ name: "original.png", imageId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await store.read(image.imageId!, "preview")).toBe(`data:image/webp;base64,${Buffer.from("small-webp").toString("base64")}`);
    expect(compress).toHaveBeenCalledOnce();
    expect((await store.read(image.imageId!, "original")).length).toBeGreaterThan(1_000_000);
  });

  it("keeps embedded originals on the server and projects event images without changing stored model inputs", async () => {
    const { store, compress } = await fixture();
    const dataUrl = `data:image/png;base64,${Buffer.alloc(900_000, 6).toString("base64")}`;
    const detail = { messages: [{ role: "user", images: [dataUrl] }], events: [{ message: { role: "user", images: [dataUrl] } }] };
    const projected = await store.project(detail);
    expect(JSON.stringify(projected)).not.toContain(dataUrl);
    expect(JSON.stringify(projected).length).toBeLessThan(1000);
    expect(detail.messages[0].images).toEqual([dataUrl]);
    const image = (projected.messages[0] as unknown as { presentation: { attachments: [{ imageId: string }] } }).presentation.attachments[0];
    expect(await store.read(image.imageId, "original")).toBe(dataUrl);
    expect(compress).not.toHaveBeenCalled();
  });

  it("reuses preview generation and survives a new server store instance", async () => {
    const { directory, store, compress } = await fixture();
    const image = await store.register({ type: "image", name: "one.png", dataUrl: "data:image/png;base64,AQID" });
    const previews = await Promise.all(Array.from({ length: 8 }, () => store.read(image.imageId!, "preview")));
    expect(new Set(previews).size).toBe(1);
    expect(compress).toHaveBeenCalledOnce();
    const restarted = new SessionImageStore(join(directory, "cache"), compress);
    expect(await restarted.read(image.imageId!, "preview")).toBe(previews[0]);
    expect(await restarted.read(image.imageId!, "original")).toBe("data:image/png;base64,AQID");
    expect(compress).toHaveBeenCalledOnce();
  });

  it("never exposes partial originals during concurrent registration", async () => {
    const { store } = await fixture();
    const dataUrl = `data:image/png;base64,${Buffer.alloc(200_000, 8).toString("base64")}`;
    await Promise.all(Array.from({ length: 10 }, async () => {
      const image = await store.register({ type: "image", name: "one.png", dataUrl });
      expect(await store.read(image.imageId!, "original")).toBe(dataUrl);
    }));
  });

  it("rejects arbitrary cache paths and changed native files", async () => {
    const { directory, store } = await fixture();
    await expect(store.read("../../secret", "original")).rejects.toThrow("Invalid image");
    const path = join(directory, "one.png");
    await writeFile(path, "first");
    const image = await store.register({ type: "image", name: "one.png", localImagePath: path });
    await writeFile(path, "changed image");
    await expect(store.read(image.imageId!, "original")).rejects.toThrow("Image unavailable");
    expect(await readFile(path, "utf8")).toBe("changed image");
  });

  it("does not inline unsupported or missing images as a fallback", async () => {
    const { directory, store } = await fixture();
    expect(await store.register({ type: "image", name: "bad", dataUrl: "data:image/png;base64,!!!" })).toEqual({ type: "image", name: "bad", unavailable: true });
    expect(await store.register({ type: "image", name: "missing.png", localImagePath: join(directory, "missing.png") })).toEqual({ type: "image", name: "missing.png", unavailable: true });
  });
});
