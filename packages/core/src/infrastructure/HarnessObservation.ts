import { createHash } from 'node:crypto';

/** Bounded private diagnostic previews. Never collect images or hidden reasoning. */
export function redactDiagnostic(text: string): string {
  return text.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}
export function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return redactDiagnostic(value).slice(0, 1600);
  if (Array.isArray(value)) return value.slice(0, 24).map(item => diagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) =>
    [key, /api.?key|token$|password|secret|authorization|cookie|images|reasoning/i.test(key) && !/tokens|ratio/i.test(key)
      ? '[REDACTED]' : diagnosticValue(item, depth + 1)]));
  return value;
}
export function diagnosticHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 24);
}
