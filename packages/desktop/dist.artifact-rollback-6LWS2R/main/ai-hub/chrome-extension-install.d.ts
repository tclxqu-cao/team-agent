/** A per-user install directory keeps bootstrap credentials out of distributed code. */
export declare function prepareChromeExtension(source: string, destination: string, pairingCode: string): string;
export declare function showChromeExtensionSetup(actions: {
    prepare(): string;
    copyPath(path: string): void;
    reveal(path: string): void;
    openManager(): Promise<void>;
}): Promise<{
    path: string;
    browserOpened: boolean;
}>;
//# sourceMappingURL=chrome-extension-install.d.ts.map