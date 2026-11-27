export declare const WEB_SHELL_OPEN_TERMINAL_TYPE = "agent-web-shell:open-terminal:v1";
export declare const WEB_SHELL_NEW_TERMINAL_HASH = "#new-terminal";
export declare function webShellTerminalUrl(origin: string): string;
export interface WebShellOpenTerminalMessage {
    type: typeof WEB_SHELL_OPEN_TERMINAL_TYPE;
}
export declare function readWebShellOpenTerminal(event: Pick<MessageEvent, "data" | "origin" | "source">, expectedOrigin: string, expectedSource: MessageEventSource | null): WebShellOpenTerminalMessage | null;
//# sourceMappingURL=WebShellTerminalBridge.d.ts.map