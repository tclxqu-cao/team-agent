import { TodoError, validateTimestamp, type TodoTrigger } from "./entities";

type CronField = { values: number[]; wildcard: boolean };
function field(text: string, min: number, max: number, dow = false): CronField {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new TodoError("INVALID_ARGUMENT", "cron 只支持五字段数字、范围、列表及步长");
    const step = Number(match[2] ?? 1);
    const bounds = match[1] === "*" ? [min, max] : match[1].split("-").map(Number);
    const [lo, hi = match[2] ? max : lo] = bounds;
    if (step < 1 || step > max + 1 || lo < min || hi > max || lo > hi) throw new TodoError("INVALID_ARGUMENT", "cron 字段超出范围");
    for (let n = lo; n <= hi; n += step) values.add(dow && n === 7 ? 0 : n);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: text === "*" };
}
/** Wall-clock recurrence, independent of the server's timezone. A repeated DST
 * minute fires at its first occurrence; a nonexistent local minute is skipped. */
export class ReminderScheduleCalculator {
  next(trigger: TodoTrigger, timeZone: string, afterMs: number): number | null {
    return this.calculate(trigger, timeZone, afterMs, 1);
  }
  previous(trigger: TodoTrigger, timeZone: string, atOrBeforeMs: number): number | null {
    return this.calculate(trigger, timeZone, atOrBeforeMs, -1);
  }
  private calculate(trigger: TodoTrigger, timeZone: string, afterMs: number, direction: 1 | -1): number | null {
    validateTimestamp(afterMs);
    let fmt: Intl.DateTimeFormat;
    try { fmt = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
    catch { throw new TodoError("INVALID_ARGUMENT", "无效的 IANA 时区"); }
    if (!trigger || !["once", "cron"].includes(trigger.kind)) throw new TodoError("INVALID_ARGUMENT", "请指定一次性或 cron 触发规则");
    if (trigger.kind === "once") { validateTimestamp(trigger.at); return (direction === 1 ? trigger.at > afterMs : trigger.at <= afterMs) ? trigger.at : null; }
    if (typeof trigger.expression !== "string") throw new TodoError("INVALID_ARGUMENT", "cron 表达式不能为空");
    const tokens = trigger.expression.trim().split(/\s+/);
    if (tokens.length !== 5) throw new TodoError("INVALID_ARGUMENT", "cron 必须为五字段");
    const [minutes, hours, dom, months, dow] = [field(tokens[0], 0, 59), field(tokens[1], 0, 23), field(tokens[2], 1, 31), field(tokens[3], 1, 12), field(tokens[4], 0, 7, true)];
    const parts = (ms: number) => Object.fromEntries(fmt.formatToParts(ms).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
    const local = parts(afterMs);
    const start = Date.UTC(local.year, local.month - 1, local.day);
    for (let index = 0; index < 366 * 8; index++) {
      const day = start + direction * index * 86400000;
      const date = new Date(day), d = date.getUTCDate(), w = date.getUTCDay();
      if (!months.values.includes(date.getUTCMonth() + 1)) continue;
      const matchesDay = dom.wildcard ? dow.values.includes(w) : dow.wildcard ? dom.values.includes(d) : dom.values.includes(d) || dow.values.includes(w);
      if (!matchesDay) continue;
      const offsets = new Set<number>();
      for (const delta of [-86400000, 0, 86400000]) {
        const probe = day + 43200000 + delta, p = parts(probe);
        offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - probe);
      }
      for (const hour of direction === 1 ? hours.values : [...hours.values].reverse()) for (const minute of direction === 1 ? minutes.values : [...minutes.values].reverse()) {
        const wall = day + hour * 3600000 + minute * 60000;
        const candidates = [...offsets].map(offset => wall - offset).filter(ms => { const p = parts(ms); return p.year === date.getUTCFullYear() && p.month === date.getUTCMonth() + 1 && p.day === d && p.hour === hour && p.minute === minute; }).sort((a, b) => a - b);
        if (candidates[0] !== undefined && (direction === 1 ? candidates[0] > afterMs : candidates[0] <= afterMs)) return candidates[0];
      }
    }
    return null;
  }
}
