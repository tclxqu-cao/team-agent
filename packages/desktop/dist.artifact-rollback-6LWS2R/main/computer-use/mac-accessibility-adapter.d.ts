import { type AccessibilitySnapshotResult } from "@agent/computer-use";
export interface MacAccessibilityGateway {
    start(): Promise<void>;
    checkAccessibility(): Promise<boolean>;
    snapshotAccessibility(): Promise<AccessibilitySnapshotResult>;
    performAccessibilityAction(revision: string, nodeId: string, action: "press" | "focus"): Promise<void>;
    setAccessibilityText(revision: string, nodeId: string, text: string, replace: boolean): Promise<void>;
}
export declare class MacAccessibilityAdapter {
    private readonly gateway;
    constructor(gateway: MacAccessibilityGateway);
    isTrusted(): Promise<boolean>;
    snapshot(): Promise<AccessibilitySnapshotResult>;
    ensureTrusted(): Promise<void>;
    perform(revision: string, nodeId: string, action: "press" | "focus"): Promise<void>;
    setText(revision: string, nodeId: string, text: string, replace: boolean): Promise<void>;
}
//# sourceMappingURL=mac-accessibility-adapter.d.ts.map