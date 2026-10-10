/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) with ranges, lists, steps, names and
 * the usual macros (@hourly, @daily, @weekly, @monthly, @yearly). Timezone-aware via Intl. Pure + tested.
 * Day-of-month / day-of-week follow Vixie cron: if both are restricted, either may match.
 */

type Field = { set: Set<number>; star: boolean };
export type CronExpr = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; source: string };

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(src: string, min: number, max: number, names?: string[], offset = 0): Field {
  const set = new Set<number>();
  const val = (s: string) => {
    const lower = s.toLowerCase();
    if (names) {
      const i = names.indexOf(lower);
      if (i >= 0) return i + offset;
    }
    if (!/^\d+$/.test(s)) throw new Error(`Invalid value "${s}"`);
    return Number(s);
  };
  for (const part of src.split(",")) {
    const [rangeStr, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
    let lo: number, hi: number;
    if (rangeStr === "*" || rangeStr === "?") {
      lo = min;
      hi = max;
    } else if (rangeStr!.includes("-")) {
      const [a, b] = rangeStr!.split("-");
      lo = val(a!);
      hi = val(b!);
    } else {
      lo = val(rangeStr!);
      hi = stepStr === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Value out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star: src === "*" || src === "?" };
}

export function parseCron(expr: string): CronExpr {
  const src = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new Error("A cron expression needs 5 fields: minute hour day-of-month month day-of-week");
  const dow = parseField(parts[4]!, 0, 7, DAYS);
  if (dow.set.has(7)) {
    dow.set.delete(7);
    dow.set.add(0);
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12, MONTHS, 1),
    dow,
    source: expr.trim(),
  };
}

export function isValidCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock fields of an instant in a timezone. */
export function zonedParts(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour! % 24, minute: +p.minute!, dow: DAYS.indexOf(p.weekday!.toLowerCase().slice(0, 3)) };
}

export function cronMatches(c: CronExpr, ms: number, tz = "UTC"): boolean {
  const z = zonedParts(ms, tz);
  if (!c.minute.set.has(z.minute) || !c.hour.set.has(z.hour) || !c.month.set.has(z.month)) return false;
  const domOk = c.dom.set.has(z.day);
  const dowOk = c.dow.set.has(z.dow);
  if (c.dom.star && c.dow.star) return true;
  if (c.dom.star) return dowOk;
  if (c.dow.star) return domOk;
  return domOk || dowOk;
}

/** Next run strictly after `after` (minute resolution). Searches up to ~4 years. */
export function nextRun(expr: string | CronExpr, after: Date | number = Date.now(), tz = "UTC"): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  let t = Math.floor(+after / 60_000) * 60_000 + 60_000;
  const limit = t + 4 * 366 * 86400_000;
  while (t < limit) {
    const z = zonedParts(t, tz);
    if (!c.month.set.has(z.month)) {
      t += (24 * 60 - z.hour * 60 - z.minute) * 60_000; // jump to next local day
      continue;
    }
    if (!c.hour.set.has(z.hour)) {
      t += (60 - z.minute) * 60_000; // next hour
      continue;
    }
    if (cronMatches(c, t, tz)) return new Date(t);
    t += 60_000;
  }
  return null;
}

/** Human summary for common patterns (UI hint). */
export function describeCron(expr: string): string {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const known: Record<string, string> = {
    "* * * * *": "every minute",
    "*/5 * * * *": "every 5 minutes",
    "*/10 * * * *": "every 10 minutes",
    "*/15 * * * *": "every 15 minutes",
    "*/30 * * * *": "every 30 minutes",
    "0 * * * *": "every hour",
    "0 0 * * *": "every day at 00:00",
    "0 0 * * 0": "every Sunday at 00:00",
    "0 0 1 * *": "on the 1st of every month",
  };
  if (known[e]) return known[e]!;
  const m = /^(\d+) (\d+) \* \* \*$/.exec(e);
  if (m) return `every day at ${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
  return e;
}
