export interface FileLineStats {
    added: number;
    removed: number;
}
export type FileChangeOperation = "add" | "update" | "delete";
export interface FileChangeSummary {
    operation: FileChangeOperation;
    fileCount: number;
    lineStats: FileLineStats | null;
}
export declare function textLines(text: string): string[];
export declare function fileChangeOperation(change: Record<string, unknown>): FileChangeOperation | null;
export declare function isFileLineStats(value: unknown): value is FileLineStats;
export declare function fileChangeLineStats(change: Record<string, unknown>): FileLineStats | null;
export declare function summarizeFileChanges(changes: Record<string, unknown>[]): FileChangeSummary | null;
/** Counts changed lines without mistaking large unchanged context for additions. */
export declare function textLineStats(before: string, after: string): FileLineStats | null;
//# sourceMappingURL=file-change-summary.d.ts.map