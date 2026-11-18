const previews = new Map<string, Promise<string>>();

/** Share small previews across retained message windows; full images stay out of this cache. */
export function loadMessageImagePreview(id: string, load: () => Promise<string>): Promise<string> {
  const cached = previews.get(id);
  if (cached) return cached;
  const pending = load();
  previews.set(id, pending);
  if (previews.size > 128) previews.delete(previews.keys().next().value!);
  void pending.catch(() => { if (previews.get(id) === pending) previews.delete(id); });
  return pending;
}

/** Newly sent images already exist locally; only their display copy is resized. */
export async function localMessageImagePreview(src: string): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const scale = Math.min(1, 384 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法生成图片预览");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.6);
}
