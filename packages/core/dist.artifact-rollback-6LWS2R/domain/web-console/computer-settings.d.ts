export declare const COMPUTER_TOOLS: readonly ["refresh", "dashboard", "collaboration", "remote", "theme", "files", "ai-hub", "flow", "install", "calendar"];
export type ComputerToolId = typeof COMPUTER_TOOLS[number];
export declare const DEFAULT_COMPUTER_TOOLS: readonly ComputerToolId[];
export interface SavedComputerPage {
    id: string;
    name: string;
    url: string;
    openMode: "current" | "new-tab";
}
export interface ComputerSettings {
    userId: string;
    revision: number;
    visibleTools: ComputerToolId[];
    /** NULL means legacy browser pages have not been imported yet; [] means initialized and empty. */
    savedPages: SavedComputerPage[] | null;
    updatedAt: string;
}
export declare function defaultComputerSettings(userId: string): ComputerSettings;
export declare function validateComputerTools(value: unknown): ComputerToolId[];
export declare function validateSavedComputerPages(value: unknown): SavedComputerPage[];
//# sourceMappingURL=computer-settings.d.ts.map