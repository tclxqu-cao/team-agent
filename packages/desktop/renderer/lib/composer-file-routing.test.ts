import { describe, expect, it, vi } from "vitest";
import { prepareComposerFiles } from "./composer-file-routing";

function file(name: string, type: string) {
  return { name, type };
}

describe("prepareComposerFiles", () => {
  it("converts every supported selected image and keeps non-images separate", async () => {
    const files = [
      file("photo.jpg", "image/jpeg"),
      file("diagram.png", "IMAGE/PNG"),
      file("animation.gif", "image/gif"),
      file("capture.webp", "image/webp"),
      file("notes.md", "text/markdown"),
    ];
    const readImage = vi.fn(async (selected: { name: string }) => `data:${selected.name}`);

    await expect(prepareComposerFiles(files, readImage)).resolves.toEqual({
      images: [
        "data:photo.jpg",
        "data:diagram.png",
        "data:animation.gif",
        "data:capture.webp",
      ],
      attachments: [files[4]],
      unsupportedImages: [],
      failedImages: [],
    });
    expect(readImage).toHaveBeenCalledTimes(4);
  });

  it("reports unsupported and unreadable images without turning them into attachments", async () => {
    const unsupported = file("photo.heic", "image/heic");
    const unreadable = file("broken.png", "image/png");

    await expect(prepareComposerFiles(
      [unsupported, unreadable],
      async () => { throw new Error("read failed"); },
    )).resolves.toEqual({
      images: [],
      attachments: [],
      unsupportedImages: [unsupported],
      failedImages: [unreadable],
    });
  });
});
