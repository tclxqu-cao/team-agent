import type { PinnedCommand } from "./entities.js";
export declare const MAX_PINNED_COMMANDS = 50;
export declare const MAX_PINNED_COMMAND_LENGTH = 1000;
export declare function defaultPinnedCommands(): PinnedCommand[];
export declare function validatePinnedCommands(value: unknown): PinnedCommand[];
export declare function parseStoredPinnedCommands(value: string | null | undefined): PinnedCommand[];
//# sourceMappingURL=pinned-commands.d.ts.map