/**
 * Parse an interval shorthand like "5m", "30s", "2h" into milliseconds.
 * Returns null if the expression is not a recognised shorthand.
 */
export declare function parseIntervalMs(expr: string): number | null;
/** Returns true if expr looks like a 5-field cron expression */
export declare function isCronExpression(expr: string): boolean;
/**
 * Compute the next fire timestamp (ms) for a cron or interval expression.
 * @param cron - cron expression ("0 9 * * *") or interval shorthand ("5m")
 * @param fromMs - reference time in ms (defaults to now)
 */
export declare function computeNextFireAt(cron: string, fromMs?: number): number;
/** Human-readable description of a cron/interval expression */
export declare function describeCron(cron: string): string;
/**
 * List fire timestamps (ms) of a cron/interval expression inside [fromMs, toMs].
 * Interval shorthands step from `anchorMs` (defaults to fromMs) so callers can
 * align expansions with a task's real schedule anchor (nextFireAt/lastFiredAt).
 */
export declare function listCronFires(cron: string, fromMs: number, toMs: number, opts?: {
    anchorMs?: number;
    limit?: number;
}): number[];
//# sourceMappingURL=cronParser.d.ts.map