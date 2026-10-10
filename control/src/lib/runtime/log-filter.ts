/**
 * Runtime log helpers shared by the Logs tab (client) and the download endpoint (server). Pure — no imports.
 * Lines look like "[r1] message" (replica) or "[web] message" (compose service).
 */
export type Level = "error" | "warn" | "info" | "debug";

const ERR = /\b(error|fatal|panic|exception|traceback|uncaught|unhandled|critical|crit|emerg|alert|failed|failure)\b|"level"\s*:\s*"(error|fatal|critical)"|level=(error|fatal)|\b5\d\d\s/i;
const WARN = /\b(warn|warning|deprecated|deprecation)\b|"level"\s*:\s*"warn(ing)?"|level=warn/i;
const DEBUG = /\b(debug|trace|verbose)\b|"level"\s*:\s*"(debug|trace)"|level=(debug|trace)/i;

export function detectLevel(line: string): Level {
  const msg = stripPrefix(line).msg;
  if (ERR.test(msg)) return "error";
  if (WARN.test(msg)) return "warn";
  if (DEBUG.test(msg)) return "debug";
  return "info";
}

const PREFIX = /^\[([a-z0-9_.-]+)\]\s?/i;
export function stripPrefix(line: string): { source: string | null; msg: string } {
  const m = PREFIX.exec(line);
  return m ? { source: m[1]!, msg: line.slice(m[0].length) } : { source: null, msg: line };
}

const RANK: Record<Level, number> = { error: 3, warn: 2, info: 1, debug: 0 };

export type LogFilter = { level?: "all" | Level; q?: string; replica?: string; since?: number; until?: number };

/** level = minimum severity (error < warn < info < debug shows everything). */
export function filterLogLines<T extends { ts: number; line: string }>(lines: T[], f: LogFilter): T[] {
  const q = f.q?.trim().toLowerCase();
  const min = f.level && f.level !== "all" ? RANK[f.level] : -1;
  return lines.filter((l) => {
    if (f.since && l.ts < f.since) return false;
    if (f.until && l.ts > f.until) return false;
    if (f.replica && f.replica !== "all" && stripPrefix(l.line).source !== f.replica) return false;
    if (min >= 0 && RANK[detectLevel(l.line)] < min) return false;
    if (q && !l.line.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function sourcesOf(lines: Array<{ line: string }>): string[] {
  const s = new Set<string>();
  for (const l of lines) {
    const p = stripPrefix(l.line).source;
    if (p) s.add(p);
  }
  return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
