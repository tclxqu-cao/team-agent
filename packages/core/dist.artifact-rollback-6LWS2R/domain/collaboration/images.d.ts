import { type CollaborationDiscussionState } from "./types.js";
export declare const COLLABORATION_IMAGE_LIMIT = 10;
export declare const COLLABORATION_IMAGE_MAX_BYTES: number;
export declare function validateCollaborationImages(images: unknown): asserts images is string[] | undefined;
/** Retain the latest visual context for follow-up planning and newly created workers. */
export declare function collaborationImages(state: CollaborationDiscussionState): string[] | undefined;
//# sourceMappingURL=images.d.ts.map