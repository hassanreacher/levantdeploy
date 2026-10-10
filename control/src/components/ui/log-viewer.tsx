"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronDown, ChevronUp, Download, Search, WrapText } from "lucide-react";
import { parseAnsi, stripAnsi } from "@/lib/ansi";
import { cn } from "@/lib/utils";
import { Switch } from "./switch";

export type LogViewerLine = { id: string; ts: number; line: string };

const ROW = 20; // px, fixed row height → simple virtualisation
const OVERSCAN = 30;

/**
 * Virtualised log viewer with ANSI colours, search (highlight + next/prev), follow toggle and download.
 *
 *   <LogViewer deploymentId={d.id} stream="BUILD" />               // live: consumes the SSE endpoint
 *   <LogViewer src="/api/v1/…/logs" />                               // custom SSE URL (same event format)
 *   <LogViewer lines={[{ id: "1", ts: Date.now(), line: "hello" }]} />   // static
 */
export function LogViewer({
  deploymentId,
  stream = "BUILD",
  src,
  lines: staticLines,
  height = 480,
  className,
  showTimestamps = true,
  emptyText = "Waiting for logs…",
  onEnd,
}: {
  deploymentId?: string;
  stream?: "BUILD" | "RUNTIME";
  src?: string;
  lines?: LogViewerLine[];
  height?: number | string;
  className?: string;
  showTimestamps?: boolean;
  emptyText?: string;
  onEnd?: () => void;
}) {
  const [lines, setLines] = useState<LogViewerLine[]>(staticLines ?? []);
  const [state, setState] = useState<"connecting" | "live" | "ended" | "error" | "static">(staticLines ? "static" : "connecting");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(typeof height === "number" ? height : 480);
  const box = useRef<HTMLDivElement>(null);
  const buffer = useRef<LogViewerLine[]>([]);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    if (staticLines) setLines(staticLines);
  }, [staticLines]);

  // SSE subscription (batched into animation frames)
  const url = src ?? (deploymentId ? `/api/v1/deployments/${deploymentId}/logs?stream=${stream}` : null);
  useEffect(() => {
    if (!url || staticLines) return;
    setLines([]);
    setState("connecting");
    const es = new EventSource(url);
    let raf = 0;
    let opened = false;
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // Fallback (dashboard area): browsers allow only ~6 HTTP/1.1 connections per host, so with several dashboard tabs
    // open (each holding SSE streams) a new EventSource can queue forever. If it hasn't opened after 5 s, close it and
    // poll the JSON form of the same endpoint instead (only for the built-in deployment log URL).
    const fallback = setTimeout(() => {
      if (opened || src || !deploymentId) return;
      es.close();
      setState("live");
      let cursor: string | null = null;
      const poll = async () => {
        if (stopped) return;
        try {
          const res = await fetch(`${url}&format=json&limit=2000${cursor ? `&from=${encodeURIComponent(cursor)}` : ""}`, { credentials: "same-origin" });
          if (!res.ok) throw new Error(String(res.status));
          const page = (await res.json()) as { lines: LogViewerLine[]; next: string | null; ended: boolean; source: string };
          if (page.lines.length) {
            buffer.current.push(...page.lines);
            if (!raf) raf = requestAnimationFrame(flush);
          }
          cursor = page.next ?? cursor;
          if (page.lines.length === 2000) return void (pollTimer = setTimeout(poll, 0));
          if (page.ended || page.source === "archive") {
            flush();
            setState("ended");
            onEndRef.current?.();
            return;
          }
        } catch {
          setState("error");
        }
        pollTimer = setTimeout(poll, 2000);
      };
      void poll();
    }, 5000);
    const flush = () => {
      raf = 0;
      if (!buffer.current.length) return;
      const add = buffer.current;
      buffer.current = [];
      setLines((l) => (l.length + add.length > 100_000 ? [...l, ...add].slice(-100_000) : [...l, ...add]));
    };
    es.onopen = () => {
      opened = true;
      setState("live");
    };
    es.onmessage = (e) => {
      opened = true;
      try {
        buffer.current.push(JSON.parse(e.data) as LogViewerLine);
        if (!raf) raf = requestAnimationFrame(flush);
      } catch {}
    };
    es.addEventListener("end", () => {
      flush();
      setState("ended");
      es.close();
      onEndRef.current?.();
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setState("error");
    };
    return () => {
      stopped = true;
      clearTimeout(fallback);
      if (pollTimer) clearTimeout(pollTimer);
      es.close();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [url, staticLines]); // eslint-disable-line react-hooks/exhaustive-deps

  // viewport height
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plain = useMemo(() => lines.map((l) => stripAnsi(l.line)), [lines]);
  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    const res: number[] = [];
    plain.forEach((p, i) => p.toLowerCase().includes(q) && res.push(i));
    return res;
  }, [plain, query]);

  const scrollToRow = useCallback((i: number) => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 2);
  }, []);

  // follow: stick to the bottom as lines arrive
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length, follow, wrap]);

  useEffect(() => {
    setMatchIdx(0);
    if (matches.length) {
      setFollow(false);
      scrollToRow(matches[0]!);
    }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const gotoMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const n = (matchIdx + dir + matches.length) % matches.length;
    setMatchIdx(n);
    setFollow(false);
    scrollToRow(matches[n]!);
  };

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2;
    if (!atBottom && follow) setFollow(false);
    if (atBottom && !follow && state === "live") setFollow(true);
  };

  const download = () => {
    const blob = new Blob([plain.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${deploymentId ?? "logs"}-${stream.toLowerCase()}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // virtual window (disabled when wrapping: variable heights)
  const total = lines.length;
  const start = wrap ? 0 : Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = wrap ? total : Math.min(total, Math.ceil((scrollTop + viewH) / ROW) + OVERSCAN);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const current = matches[matchIdx];

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border border-border bg-bg-subtle", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-md border border-border bg-bg px-2.5 focus-within:border-fg/40">
          <Search className="h-3.5 w-3.5 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && gotoMatch(e.shiftKey ? -1 : 1)}
            placeholder="Search logs"
            className="h-full flex-1 bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
            aria-label="Search logs"
          />
          {query && (
            <span className="font-mono text-[11px] text-subtle">
              {matches.length ? `${matchIdx + 1}/${matches.length}` : "0/0"}
            </span>
          )}
          <button className="text-muted hover:text-fg" onClick={() => gotoMatch(-1)} aria-label="Previous match">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button className="text-muted hover:text-fg" onClick={() => gotoMatch(1)} aria-label="Next match">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-muted">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                state === "live" ? "animate-pulse2 bg-success" : state === "error" ? "bg-danger" : state === "connecting" ? "bg-warning" : "bg-subtle",
              )}
            />
            {state === "live" ? "Live" : state === "ended" ? "Finished" : state === "error" ? "Disconnected" : state === "connecting" ? "Connecting" : `${total} lines`}
          </span>
          <label className="flex cursor-pointer items-center gap-1.5">
            <Switch size="sm" checked={follow} onCheckedChange={setFollow} label="Follow" />
            Follow
          </label>
          <button onClick={() => setWrap((w) => !w)} className={cn("rounded p-1 hover:bg-surface-2 hover:text-fg", wrap && "text-fg")} title="Wrap lines" aria-label="Wrap lines">
            <WrapText className="h-3.5 w-3.5" />
          </button>
          <button onClick={download} className="rounded p-1 hover:bg-surface-2 hover:text-fg" title="Download" aria-label="Download logs">
            <Download className="h-3.5 w-3.5" />
          </button>
          {!follow && (
            <button
              onClick={() => {
                setFollow(true);
                if (box.current) box.current.scrollTop = box.current.scrollHeight;
              }}
              className="rounded p-1 hover:bg-surface-2 hover:text-fg"
              title="Jump to bottom"
              aria-label="Jump to bottom"
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div ref={box} onScroll={onScroll} style={{ height }} className="relative overflow-auto font-mono text-[12.5px] leading-5" data-testid="log-viewer">
        {total === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-subtle">{state === "ended" ? "No logs" : emptyText}</div>
        ) : (
          <div style={{ height: wrap ? undefined : total * ROW, position: "relative" }}>
            <div style={{ transform: wrap ? undefined : `translateY(${start * ROW}px)` }}>
              {lines.slice(start, end).map((l, k) => {
                const i = start + k;
                return (
                  <div
                    key={l.id + ":" + i}
                    className={cn(
                      "flex px-3 hover:bg-surface-2/50",
                      wrap ? "min-h-5" : "h-5",
                      matchSet.has(i) && "bg-warning/10",
                      i === current && "bg-warning/25",
                    )}
                  >
                    <span className="w-12 shrink-0 select-none pr-3 text-right text-subtle/70">{i + 1}</span>
                    {showTimestamps && (
                      <span className="w-[76px] shrink-0 select-none text-subtle">{l.ts ? new Date(l.ts).toLocaleTimeString(undefined, { hour12: false }) : ""}</span>
                    )}
                    <span className={cn("min-w-0 flex-1 text-fg/90", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
                      <AnsiLine text={l.line} query={query} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AnsiLine({ text, query }: { text: string; query: string }) {
  const segs = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {segs.map((s, i) => (
        <span
          key={i}
          style={{
            color: s.style.fg,
            backgroundColor: s.style.bg,
            fontWeight: s.style.bold ? 600 : undefined,
            opacity: s.style.dim ? 0.6 : undefined,
            fontStyle: s.style.italic ? "italic" : undefined,
            textDecoration: s.style.underline ? "underline" : undefined,
          }}
        >
          {query ? <Highlight text={s.text} q={query} /> : s.text}
        </span>
      ))}
    </>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let j: number;
  while ((j = lower.indexOf(ql, i)) >= 0) {
    if (j > i) parts.push(text.slice(i, j));
    parts.push(
      <mark key={j} className="rounded-sm bg-warning/60 text-fg">
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}
