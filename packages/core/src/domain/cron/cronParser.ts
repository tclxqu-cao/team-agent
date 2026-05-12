// ── Cron / Interval Expression Parser ──

/**
 * Parse an interval shorthand like "5m", "30s", "2h" into milliseconds.
 * Returns null if the expression is not a recognised shorthand.
 */
export function parseIntervalMs(expr: string): number | null {
  // Strip optional leading 每/每隔 (Chinese "every")
  const cleaned = expr.trim().replace(/^每(?:隔)?/, '');
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分钟?|h|hr|小时)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 's' || unit === 'sec' || unit === '秒') return Math.round(n * 1_000);
  if (unit === 'm' || unit === 'min' || unit === '分' || unit === '分钟') return Math.round(n * 60_000);
  if (unit === 'h' || unit === 'hr' || unit === '小时') return Math.round(n * 3_600_000);
  return null;
}

/** Returns true if expr looks like a 5-field cron expression */
export function isCronExpression(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5;
}

/**
 * Compute the next fire timestamp (ms) for a cron or interval expression.
 * @param cron - cron expression ("0 9 * * *") or interval shorthand ("5m")
 * @param fromMs - reference time in ms (defaults to now)
 */
export function computeNextFireAt(cron: string, fromMs: number = Date.now()): number {
  const intervalMs = parseIntervalMs(cron);
  if (intervalMs !== null) return fromMs + intervalMs;
  if (isCronExpression(cron)) return nextCronFire(cron, fromMs);
  throw new Error(`Unrecognised cron expression: "${cron}"`);
}

function matchField(value: number, expr: string): boolean {
  if (expr === '*') return true;
  if (expr.includes('/')) {
    const [rangePart, stepPart] = expr.split('/');
    const step = parseInt(stepPart, 10);
    const start = rangePart === '*' ? 0 : parseInt(rangePart, 10);
    return value >= start && (value - start) % step === 0;
  }
  if (expr.includes(',')) return expr.split(',').some(e => matchField(value, e.trim()));
  if (expr.includes('-')) {
    const [lo, hi] = expr.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(expr, 10) === value;
}

function nextCronFire(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron (expected 5 fields): "${expr}"`);
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;

  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  let t = new Date(start.getTime() + 60_000); // advance to next minute

  // Scan up to 1 year (525,600 minutes)
  for (let i = 0; i < 525_600; i++) {
    if (
      matchField(t.getMinutes(), minExpr) &&
      matchField(t.getHours(), hourExpr) &&
      matchField(t.getDate(), domExpr) &&
      matchField(t.getMonth() + 1, monExpr) &&
      matchField(t.getDay(), dowExpr)
    ) {
      return t.getTime();
    }
    t = new Date(t.getTime() + 60_000);
  }
  return fromMs + 3_600_000; // fallback: 1 hour
}

/** Human-readable description of a cron/interval expression */
export function describeCron(cron: string): string {
  const ms = parseIntervalMs(cron);
  if (ms !== null) {
    if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `每 ${ms / 3_600_000} 小时`;
    if (ms >= 60_000 && ms % 60_000 === 0) return `每 ${ms / 60_000} 分钟`;
    return `每 ${ms / 1_000} 秒`;
  }
  // Cron expression — attempt a human summary
  const [min, hour] = cron.trim().split(/\s+/);
  if (min === '0' && hour !== '*' && !hour.includes('/') && !hour.includes(','))
    return `每天 ${hour.padStart(2, '0')}:00`;
  return `cron: ${cron}`;
}
