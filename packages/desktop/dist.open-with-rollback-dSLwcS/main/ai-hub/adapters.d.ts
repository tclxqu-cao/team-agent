import type { HubAdapterId } from "./config";
export declare function buildFocusInputScript(adapter: HubAdapterId | undefined): string;
export declare function buildFillInputScript(adapter: HubAdapterId | undefined, text: string): string;
export declare function buildSubmissionProbeScript(baseline: {
    url: string;
    userCount: number;
    outputCount: number;
    inputLength: number;
}): string;
export declare function buildAdapterScript(adapter: HubAdapterId | undefined, text: string): string;
export declare const ENTER_DISPATCH_SCRIPT = "(() => {\n  const el = document.activeElement;\n  if (!el) return false;\n  const options = { key: \"Enter\", code: \"Enter\", keyCode: 13, which: 13, bubbles: true, cancelable: true };\n  el.dispatchEvent(new KeyboardEvent(\"keydown\", options));\n  el.dispatchEvent(new KeyboardEvent(\"keyup\", options));\n  return true;\n})()";
export declare function buildContinueProbeScript(): string;
export declare const CONTINUE_BUTTON_SCRIPT: string;
export declare const CONTINUE_TARGET_SCRIPT: string;
export declare const CONVERSATION_EXTRACT_SCRIPT: string;
//# sourceMappingURL=adapters.d.ts.map