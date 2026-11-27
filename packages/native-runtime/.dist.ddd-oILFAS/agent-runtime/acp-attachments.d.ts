import type { PromptAttachment } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
/** Antigravity's local tools consume binary files by path. Its workspace
 * allowlist includes only the directory owned by this connection. */
export declare class AcpAttachmentStore {
    private directory?;
    root(): Promise<string>;
    stage(name: string, bytes: Buffer): Promise<string>;
    dispose(): Promise<void>;
}
export declare function acpAttachmentBlocks(attachments: readonly PromptAttachment[], localFiles?: AcpAttachmentStore): Promise<NativeJsonPacket[]>;
//# sourceMappingURL=acp-attachments.d.ts.map