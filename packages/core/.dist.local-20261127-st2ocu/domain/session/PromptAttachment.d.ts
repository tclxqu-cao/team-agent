/** File bytes selected by the user, carried inline with a prompt and its queue entry. */
export interface PromptAttachment {
    name: string;
    mimeType: string;
    data: string;
}
export declare const MAX_PROMPT_ATTACHMENTS = 8;
export declare const MAX_PROMPT_ATTACHMENT_BYTES: number;
export declare class InvalidPromptAttachmentError extends Error {
}
export declare function readPromptAttachments(value: unknown): PromptAttachment[] | undefined;
//# sourceMappingURL=PromptAttachment.d.ts.map