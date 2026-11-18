import { expect, it, vi } from "vitest";
import { loadMessageImagePreview } from "./message-image-preview";

it("shares a preview request across visible copies without requesting any original", async () => {
  const load = vi.fn(async () => "small-preview");
  expect(await Promise.all([loadMessageImagePreview("shared-preview", load), loadMessageImagePreview("shared-preview", load)])).toEqual(["small-preview", "small-preview"]);
  expect(load).toHaveBeenCalledOnce();
});

it("lets a failed preview be retried", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("preview");
  await expect(loadMessageImagePreview("retry-preview", load)).rejects.toThrow("offline");
  expect(await loadMessageImagePreview("retry-preview", load)).toBe("preview");
});
