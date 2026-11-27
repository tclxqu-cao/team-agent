/** Expand an RRULE (with or without the RRULE: prefix) into fire timestamps
 * inside [fromMs, toMs]. Anchors interval/week/month stepping at anchorMs. */
export declare function expandRRule(rule: string, fromMs: number, toMs: number, opts?: {
    anchorMs?: number;
    limit?: number;
}): number[];
/** Human-readable Chinese label for an RRULE. */
export declare function describeRRule(rule: string): string;
/** Parse a free-form schedule expression: RRULE, 5-field cron, interval
 * shorthand ("6h") or a one-shot ISO timestamp. */
export declare function expandWhen(when: string, fromMs: number, toMs: number, opts?: {
    anchorMs?: number;
    limit?: number;
}): {
    fires: number[];
    label: string;
    oneShot: boolean;
};
//# sourceMappingURL=schedule-expand.d.ts.map