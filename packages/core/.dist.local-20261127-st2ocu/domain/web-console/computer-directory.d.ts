export interface SavedComputerConnection {
    origin: string;
    name: string;
}
export declare const MAX_SAVED_COMPUTERS = 20;
/** Connections contain display metadata only; pairing credentials stay on each device. */
export declare function validateComputerConnections(value: unknown): SavedComputerConnection[];
//# sourceMappingURL=computer-directory.d.ts.map