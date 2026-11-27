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
//# sourceMappingURL=cronParser.d.ts.map