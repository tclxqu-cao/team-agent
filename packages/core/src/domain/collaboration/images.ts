import { CollaborationError, type CollaborationDiscussionState } from "./types.js";

export const COLLABORATION_IMAGE_LIMIT = 10;
export const COLLABORATION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function validateCollaborationImages(images: unknown): asserts images is string[] | undefined {
  if (images === undefined) return;
  if (!Array.isArray(images) || images.length > COLLABORATION_IMAGE_LIMIT)
    throw new CollaborationError(`每条消息最多添加 ${COLLABORATION_IMAGE_LIMIT} 张图片`);
  let size = 0;
  for (const image of images) {
    if (typeof image !== "string" || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))
      throw new CollaborationError("图片格式无效，仅支持 JPG、PNG、GIF 和 WebP");
    size += image.length;
  }
  if (size > COLLABORATION_IMAGE_MAX_BYTES)
    throw new CollaborationError("图片总大小超过限制，请减少图片或压缩后重试");
}

/** Retain the latest visual context for follow-up planning and newly created workers. */
export function collaborationImages(state: CollaborationDiscussionState): string[] | undefined {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.kind === "user" && message.images?.length) return message.images;
  }
}
