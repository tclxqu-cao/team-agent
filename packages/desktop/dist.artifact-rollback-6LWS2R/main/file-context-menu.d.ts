export interface FileContextMenuOptions {
    label?: string;
    line?: number;
}
export interface FileContextMenuAction {
    kind: "copy" | "reveal";
    label: string;
    value: string;
}
/** Keep legacy reveal-only callers unchanged. Artifact links opt into copying;
 * an unavailable local file manager target must not remove those copy actions. */
export declare function fileContextMenuActions(value: unknown, options?: unknown, home?: string): Promise<FileContextMenuAction[]>;
/** Resolve a user-selected artifact before handing it to the native file manager. */
export declare function resolveFileForReveal(value: unknown, home?: string): Promise<string>;
export declare function fileRevealMenuLabel(platform?: NodeJS.Platform): string;
//# sourceMappingURL=file-context-menu.d.ts.map