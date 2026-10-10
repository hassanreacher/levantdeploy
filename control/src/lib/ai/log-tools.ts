import type { LogStream } from "@prisma/client";
import { readLogs } from "@/lib/logs";
import { stripAnsi } from "@/lib/ansi";

/** Bounded log access for the agent (ANSI stripped, long lines clipped). */
const MAX_SCAN_LINES = 60_000;
const MAX_LINE = 600;

const clip = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}… [+${s.length - MAX_LINE} chars]` : s);

export type LogSlice = { lines: { n: number; text: string }[]; totalScanned: number; truncated: boolean; source: string; ended: boolean };

/** Last `tail` lines (or matches of `search` with ±context) of a deployment log stream. */
export async function logSlice(deploymentId: string, stream: LogStream, opts: { tail?: number; search?: string; context?: number; maxMatches?: number } = {}): Promise<LogSlice> {
  const tail = Math.min(Math.max(opts.tail ?? 120, 1), 500);
  const ctx = Math.min(Math.max(opts.context ?? 1, 0), 5);
  const maxMatches = Math.min(opts.maxMatches ?? 60, 200);
  let needle: RegExp | null = null;
  if (opts.search) {
    try {
      needle = new RegExp(opts.search, "i");
    } catch {
      needle = new RegExp(opts.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  }
  const ring: { n: number; text: string }[] = [];
  const matches: { n: number; text: string }[] = [];
  const recent: { n: number; text: string }[] = [];
  let pendingAfter = 0;
  let n = 0;
  let from: string | undefined;
  let source = "none";
  let ended = false;
  let truncated = false;
  const emitted = new Set<number>();
  const emit = (e: { n: number; text: string }) => {
    if (emitted.has(e.n)) return;
    emitted.add(e.n);
    matches.push(e);
  };
  while (n < MAX_SCAN_LINES) {
    const page = await readLogs(deploymentId, stream, { from, limit: 5000 });
    source = page.source;
    ended = page.ended;
    if (!page.lines.length) break;
    for (const l of page.lines) {
      n++;
      const text = clip(stripAnsi(l.line));
      const entry = { n, text };
      if (needle) {
        if (needle.test(text)) {
          if (matches.length < maxMatches) {
            for (const r of recent) emit(r);
            emit(entry);
            pendingAfter = ctx;
          } else truncated = true;
        } else if (pendingAfter > 0) {
          emit(entry);
          pendingAfter--;
        }
        recent.push(entry);
        if (recent.length > ctx) recent.shift();
      } else {
        ring.push(entry);
        if (ring.length > tail) ring.shift();
      }
    }
    if (page.lines.length < 5000 || page.next === from) break;
    from = page.next ?? undefined;
  }
  if (n >= MAX_SCAN_LINES) truncated = true;
  return { lines: needle ? matches : ring, totalScanned: n, truncated: truncated || (!needle && n > tail), source, ended };
}

export const formatLines = (s: LogSlice) => s.lines.map((l) => `${String(l.n).padStart(5)} | ${l.text}`).join("\n");
