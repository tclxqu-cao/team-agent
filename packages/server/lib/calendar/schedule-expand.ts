// RRULE / schedule expansion for the calendar aggregation (read-only projection).

import { describeCron, listCronFires, parseIntervalMs } from "@agent/core";

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MAX_SPAN_MS = 366 * 86_400_000;

interface ByDay { ordinal?: number; day: number }

function numList(value: string | undefined): number[] {
  if (!value) return [];
  return value.split(",").map(part => parseInt(part.trim(), 10)).filter(Number.isFinite);
}

function parseByDay(value: string): ByDay | null {
  const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(value.trim().toUpperCase());
  if (!match || DAY_CODES[match[2]!] === undefined) return null;
  return { ...(match[1] ? { ordinal: parseInt(match[1], 10) } : {}), day: DAY_CODES[match[2]!]! };
}

function parseUntil(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : value.trim();
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pad(n: number): string {
  return `${n}`.padStart(2, "0");
}

/** Expand an RRULE (with or without the RRULE: prefix) into fire timestamps
 * inside [fromMs, toMs]. Anchors interval/week/month stepping at anchorMs. */
export function expandRRule(
  rule: string,
  fromMs: number,
  toMs: number,
  opts: { anchorMs?: number; limit?: number } = {},
): number[] {
  const text = rule.trim().replace(/^RRULE:/i, "");
  if (!text || toMs < fromMs) return [];
  const parts = new Map<string, string>();
  for (const piece of text.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).trim().toUpperCase(), piece.slice(eq + 1).trim());
  }
  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  const interval = Math.max(1, parseInt(parts.get("INTERVAL") ?? "1", 10) || 1);
  const limit = opts.limit ?? 400;
  const until = parseUntil(parts.get("UNTIL"));
  const end = Math.min(toMs, until ?? toMs, fromMs + MAX_SPAN_MS);
  if (end < fromMs) return [];
  const byHour = numList(parts.get("BYHOUR"));
  const byMinute = numList(parts.get("BYMINUTE"));
  const byMonth = numList(parts.get("BYMONTH"));
  const byMonthDay = numList(parts.get("BYMONTHDAY"));
  const byDay = (parts.get("BYDAY") ?? "").split(",").map(parseByDay).filter((d): d is ByDay => d !== null);
  const anchor = new Date(opts.anchorMs ?? fromMs);
  const fires: number[] = [];
  const push = (ms: number) => {
    if (ms >= fromMs && ms <= end && fires.length < limit) fires.push(ms);
  };
  const hours = byHour.length ? byHour : [0];
  const minutes = byMinute.length ? byMinute : [0];
  const times = hours.flatMap(h => minutes.map(m => [h, m] as const));

  if (freq === "MINUTELY" || freq === "HOURLY") {
    const step = interval * (freq === "MINUTELY" ? 60_000 : 3_600_000);
    let t = Math.floor(anchor.getTime() / 60_000) * 60_000;
    if (t < fromMs) t += Math.ceil((fromMs - t) / step) * step;
    for (; t <= end && fires.length < limit; t += step) {
      const d = new Date(t);
      if (byHour.length && !byHour.includes(d.getHours())) continue;
      if (byMinute.length && !byMinute.includes(d.getMinutes())) continue;
      if (byDay.length && !byDay.some(b => b.day === d.getDay())) continue;
      push(t);
    }
    return fires;
  }

  const anchorDay = startOfDay(anchor.getTime());
  const anchorWeek = anchorDay - anchor.getDay() * 86_400_000;
  const day = new Date(startOfDay(fromMs));
  for (let guard = 0; day.getTime() <= end && guard < 400; guard++, day.setDate(day.getDate() + 1)) {
    const dayStart = day.getTime();
    const weekday = day.getDay();
    const month = day.getMonth() + 1;
    const monthDay = day.getDate();
    let matches = false;
    if (freq === "DAILY") {
      matches = Math.round((dayStart - anchorDay) / 86_400_000) % interval === 0;
    } else if (freq === "WEEKLY") {
      const weekDiff = Math.round((dayStart - anchorWeek) / (7 * 86_400_000));
      matches = weekDiff % interval === 0 && (byDay.length ? byDay.some(b => b.day === weekday && !b.ordinal) : weekday === anchor.getDay());
    } else if (freq === "MONTHLY") {
      const monthDiff = (day.getFullYear() - anchor.getFullYear()) * 12 + day.getMonth() - anchor.getMonth();
      if (monthDiff % interval !== 0) continue;
      if (byMonthDay.length) matches = byMonthDay.includes(monthDay);
      else if (byDay.length) matches = byDay.some(b => b.day === weekday && (!b.ordinal || nthWeekdayOfMonth(day, b.ordinal!) === b.ordinal));
      else matches = monthDay === anchor.getDate();
    } else if (freq === "YEARLY") {
      if ((day.getFullYear() - anchor.getFullYear()) % interval !== 0) continue;
      if (byMonth.length && !byMonth.includes(month)) continue;
      if (byMonthDay.length) matches = byMonthDay.includes(monthDay);
      else if (byDay.length) matches = byDay.some(b => b.day === weekday && (!b.ordinal || nthWeekdayOfMonth(day, b.ordinal!) === b.ordinal));
      else matches = month === anchor.getMonth() + 1 && monthDay === anchor.getDate();
    } else {
      return [];
    }
    if (!matches) continue;
    if (byMonth.length && freq !== "YEARLY" && !byMonth.includes(month)) continue;
    for (const [h, m] of times) {
      const fire = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
      push(fire.getTime());
    }
  }
  return fires;
}

function nthWeekdayOfMonth(day: Date, ordinal: number): number {
  const weekday = day.getDay();
  const monthDay = day.getDate();
  const nth = Math.floor((monthDay - 1) / 7) + 1;
  if (ordinal > 0) return nth;
  const daysInMonth = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
  const fromEnd = Math.floor((daysInMonth - monthDay) / 7) + 1;
  return -fromEnd === ordinal ? ordinal : nth;
}

/** Human-readable Chinese label for an RRULE. */
export function describeRRule(rule: string): string {
  const text = rule.trim().replace(/^RRULE:/i, "");
  const parts = new Map<string, string>();
  for (const piece of text.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).trim().toUpperCase(), piece.slice(eq + 1).trim());
  }
  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  const interval = Math.max(1, parseInt(parts.get("INTERVAL") ?? "1", 10) || 1);
  const hours = numList(parts.get("BYHOUR"));
  const minutes = numList(parts.get("BYMINUTE"));
  const time = hours.length ? `${pad(hours[0]!)}:${pad(minutes[0] ?? 0)}` : "";
  const days = (parts.get("BYDAY") ?? "").split(",").map(parseByDay).filter((d): d is ByDay => d !== null && !d.ordinal);
  if (freq === "MINUTELY") return `每 ${interval} 分钟`;
  if (freq === "HOURLY") return `每 ${interval} 小时`;
  if (freq === "DAILY") return `每天${time ? ` ${time}` : ""}`;
  if (freq === "WEEKLY" && days.length) return `每${days.map(d => DAY_NAMES[d.day]!.replace("周", "周")).join("、")}${time ? ` ${time}` : ""}`;
  if (freq === "MONTHLY") {
    const monthDays = numList(parts.get("BYMONTHDAY"));
    if (monthDays.length) return `每月 ${monthDays.join("、")} 日${time ? ` ${time}` : ""}`;
    const ord = (parts.get("BYDAY") ?? "").split(",").map(parseByDay).filter((d): d is ByDay => d !== null && !!d.ordinal);
    if (ord.length) return `每月第 ${ord[0]!.ordinal} 个${DAY_NAMES[ord[0]!.day]!.replace("周", "周")}${time ? ` ${time}` : ""}`;
    return `每月${time ? ` ${time}` : ""}`;
  }
  if (freq === "YEARLY") return `每年${time ? ` ${time}` : ""}`;
  return text;
}

/** Parse a free-form schedule expression: RRULE, 5-field cron, interval
 * shorthand ("6h") or a one-shot ISO timestamp. */
export function expandWhen(
  when: string,
  fromMs: number,
  toMs: number,
  opts: { anchorMs?: number; limit?: number } = {},
): { fires: number[]; label: string; oneShot: boolean } {
  const text = when.trim();
  if (!text) return { fires: [], label: "", oneShot: false };
  if (/^RRULE:/i.test(text) || /FREQ=/i.test(text)) {
    return { fires: expandRRule(text, fromMs, toMs, opts), label: describeRRule(text), oneShot: false };
  }
  const iso = Date.parse(text);
  if (Number.isFinite(iso) && /\d{4}-\d{2}-\d{2}/.test(text)) {
    return { fires: iso >= fromMs && iso <= toMs ? [iso] : [], label: `一次性 ${text.slice(0, 16).replace("T", " ")}`, oneShot: true };
  }
  if (/^[\d*/,\-\s]+$/.test(text) && text.trim().split(/\s+/).length === 5) {
    return { fires: listCronFires(text, fromMs, toMs, opts), label: describeCron(text), oneShot: false };
  }
  const intervalMs = parseIntervalMs(text);
  if (intervalMs !== null) {
    return { fires: listCronFires(text, fromMs, toMs, opts), label: describeCron(text), oneShot: false };
  }
  return { fires: [], label: text, oneShot: false };
}