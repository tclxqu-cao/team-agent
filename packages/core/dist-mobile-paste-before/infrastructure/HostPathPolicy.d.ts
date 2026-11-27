export type HostPathErrorCode = "PATH_OUTSIDE_ROOT" | "PATH_NOT_FOUND" | "PATH_NOT_DIRECTORY" | "PATH_UNREADABLE";
export declare class HostPathError extends Error {
    readonly code: HostPathErrorCode;
    constructor(code: HostPathErrorCode, message: string, options?: ErrorOptions);
}
export interface HostDirectoryEntry {
    name: string;
    path: string;
    kind: "directory" | "file";
    hasChildren: boolean;
}
export declare function isPathInsideRoot(root: string, candidate: string): boolean;
export declare class HostPathPolicy {
    readonly roots: string[];
    constructor(roots: string[]);
    static fromEnvironment(value: string | undefined, fallbackRoot: string): HostPathPolicy;
    assertAllowed(candidate: string): string;
    assertDirectory(candidate: string): string;
    listDirectories(candidate: string): HostDirectoryEntry[];
    private hasAllowedDirectoryChild;
}
//# sourceMappingURL=HostPathPolicy.d.ts.map