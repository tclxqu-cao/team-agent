/** Shared UI announces readiness only after the message page has mounted. */
export declare const MESSAGING_READY = "agentroam:messaging-ready:v1";
export declare const MESSAGING_OPEN = "agentroam:messaging-open:v1";
export declare const MESSAGING_OPEN_QUERY = "openTab";
/** Only the same-origin assistant frame may open the shell's messaging tab. */
export declare function readMessagingOpen(event: Pick<MessageEvent, "data" | "origin" | "source">, origin: string, source: MessageEventSource | null): boolean;
//# sourceMappingURL=MessagingBridge.d.ts.map