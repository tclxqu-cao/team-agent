export const MINIMUM_NODE_VERSION: string;
export function parseNodeVersion(version: unknown): number[] | null;
export function compareNodeVersions(left: string, right: string): number;
export function isSupportedNodeVersion(version: unknown, minimum?: string): boolean;
export function assertSupportedNodeVersion(version?: string): void;
