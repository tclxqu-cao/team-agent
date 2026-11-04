import { useRef, useState } from "react";
import { validateCollaborationImages } from "../../../../core/src/domain/collaboration/images";
import { normalizeComposerImage } from "../../lib/browser-image-normalization";
import { prepareComposerFiles } from "../../lib/composer-file-routing";

interface Draft { text: string; images: string[] }
const EMPTY: Draft = { text: "", images: [] };

/** Text, image reads and retry identities belong to a discussion, including its first message. */
export function useCollaborationComposer(groupId: string, discussionId: string | null, onError: (message: string) => void) {
  const key = `${groupId}:${discussionId || "new"}`;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reads, setReads] = useState<Record<string, number>>({});
  const pending = useRef<{ key: string; draft: Draft; id: string }>();
  const draft = drafts[key] ?? EMPTY;
  const update = (mutate: (value: Draft) => Draft) => {
    setDrafts(values => ({ ...values, [key]: mutate(values[key] ?? EMPTY) }));
  };
  const addImages = async (files: File[]) => {
    if (!files.length) return;
    setReads(values => ({ ...values, [key]: (values[key] ?? 0) + 1 }));
    try {
      const prepared = await prepareComposerFiles(files, async file => {
        const blob = await normalizeComposerImage(file);
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("无法读取图片"));
          reader.readAsDataURL(blob);
        });
      });
      if (prepared.attachments.length || prepared.unsupportedImages.length || prepared.failedImages.length)
        onError("无法添加部分图片，仅支持 JPG、PNG、GIF 和 WebP。");
      if (prepared.images.length) update(value => ({ ...value, images: [...value.images, ...prepared.images] }));
    } catch (error) {
      onError(error instanceof Error ? error.message : "无法添加图片");
    } finally {
      setReads(values => ({ ...values, [key]: Math.max(0, (values[key] ?? 1) - 1) }));
    }
  };
  const submit = async (send: (text: string, id: string, images?: string[], onCreated?: (id: string) => void) => Promise<boolean>) => {
    if (reads[key] || (!draft.text.trim() && !draft.images.length)) return false;
    try { validateCollaborationImages(draft.images); }
    catch (error) { onError(error instanceof Error ? error.message : "图片无效"); return false; }
    if (pending.current?.key !== key || pending.current.draft !== draft)
      pending.current = { key, draft, id: crypto.randomUUID() };
    let submissionKey = key;
    const sent = await send(draft.text, pending.current.id, draft.images, id => {
      submissionKey = `${groupId}:${id}`;
      setDrafts(values => ({ ...values, [key]: EMPTY, [submissionKey]: values[key] ?? draft }));
      if (pending.current?.draft === draft) pending.current.key = submissionKey;
    });
    if (!sent) return false;
    setDrafts(values => values[submissionKey] === draft ? { ...values, [submissionKey]: EMPTY } : values);
    return true;
  };
  return {
    draft: draft.text, images: draft.images, reading: !!reads[key], addImages, submit,
    setDraft: (text: string) => update(value => ({ ...value, text })),
    removeImage: (index: number) => update(value => ({ ...value, images: value.images.filter((_, i) => i !== index) })),
  };
}
