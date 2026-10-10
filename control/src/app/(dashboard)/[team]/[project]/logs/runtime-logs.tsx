"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, ScrollText, Search, Trash2 } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LogViewer, Select, type LogViewerLine } from "@/components/ui";
import { api } from "@/lib/client/api";
import { cn, timeAgo } from "@/lib/utils";
import { detectLevel, filterLogLines, sourcesOf, type Level } from "@/lib/runtime/log-filter";

type Dep = { id: string; number: number; shortId: string; target: string; status: string; branch: string | null; isCurrentProduction: boolean; stoppedAt: string | null; createdAt: string };
type Container = { name: string; replica: number; service: string | null; state: string; running: boolean; restartCount: number; startedAt: string | null };

const MAX_LINES = 20_000;
const RANGES = [
  { value: "all", label: "All time" },
  { value: "900000", label: "Last 15 minutes" },
  { value: "3600000", label: "Last hour" },
  { value: "21600000", label: "Last 6 hours" },
  { value: "86400000", label: "Last 24 hours" },
];
const LEVELS = [
  { value: "all", label: "All levels" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings +" },
  { value: "info", label: "Info +" },
];

export function RuntimeLogs({ deployments, initialId }: { deployments: Dep[]; initialId: string | null }) {
  const [depId, setDepId] = useState(initialId);
  const [lines, setLines] = useState<LogViewerLine[]>([]);
  const [state, setState] = useState<"connecting" | "live" | "paused" | "error">("connecting");
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<"all" | Level>("all");
  const [q, setQ] = useState("");
  const [replica, setReplica] = useState("all");
  const [range, setRange] = useState("all");
  const [containers, setContainers] = useState<Container[]>([]);
  const [clearedAt, setClearedAt] = useState(0);
  const buffer = useRef<LogViewerLine[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // live tail over SSE (foundation endpoint), batched per animation frame, bounded memory
  useEffect(() => {
    if (!depId) return;
    setLines([]);
    setState("connecting");
    const es = new EventSource(`/api/v1/deployments/${depId}/logs?stream=RUNTIME`);
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pausedRef.current || !buffer.current.length) return;
      const add = buffer.current;
      buffer.current = [];
      setLines((l) => {
        const next = l.concat(add);
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };
    es.onopen = () => setState("live");
    es.onmessage = (e) => {
      try {
        buffer.current.push(JSON.parse(e.data) as LogViewerLine);
        if (buffer.current.length > MAX_LINES) buffer.current.splice(0, buffer.current.length - MAX_LINES);
        if (!raf) raf = requestAnimationFrame(flush);
      } catch {}
    };
    es.addEventListener("end", () => es.close());
    es.onerror = () => setState((s) => (s === "live" ? "live" : "error"));
    const t = setInterval(() => !pausedRef.current && buffer.current.length && !raf && (raf = requestAnimationFrame(flush)), 1000);
    return () => {
      es.close();
      clearInterval(t);
      if (raf) cancelAnimationFrame(raf);
      buffer.current = [];
    };
  }, [depId]);

  useEffect(() => {
    if (!paused && buffer.current.length) {
      const add = buffer.current;
      buffer.current = [];
      setLines((l) => l.concat(add).slice(-MAX_LINES));
    }
  }, [paused]);

  // container status (replicas)
  useEffect(() => {
    if (!depId) return;
    let stop = false;
    const load = async () => {
      try {
        const r = await api<{ containers: Container[] }>(`/api/v1/deployments/${depId}/runtime`);
        if (!stop) setContainers(r.containers);
      } catch {}
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [depId]);

  const sources = useMemo(() => sourcesOf(lines.slice(-5000)), [lines]);
  const since = range === "all" ? undefined : Date.now() - Number(range);
  const filtered = useMemo(
    () => filterLogLines(lines, { level, q, replica, since: Math.max(since ?? 0, clearedAt) || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, level, q, replica, range, clearedAt],
  );
  const counts = useMemo(() => {
    let e = 0,
      w = 0;
    for (const l of filtered) {
      const lv = detectLevel(l.line);
      if (lv === "error") e++;
      else if (lv === "warn") w++;
    }
    return { e, w };
  }, [filtered]);

  if (!deployments.length || !depId)
    return <EmptyState icon={<ScrollText className="h-5 w-5" />} title="No running deployments" description="Runtime logs appear here once a deployment is live." />;

  const dep = deployments.find((d) => d.id === depId);
  const params = new URLSearchParams({ level, ...(q ? { q } : {}), ...(replica !== "all" ? { replica } : {}), ...(since ? { since: String(since) } : {}) });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select
            aria-label="Deployment"
            className="w-full sm:w-auto"
            value={depId}
            onChange={(e) => setDepId(e.target.value)}
            options={deployments.map((d) => ({
              value: d.id,
              label: `#${d.number} · ${d.isCurrentProduction ? "Production (current)" : d.target === "PRODUCTION" ? "Production" : `Preview${d.branch ? ` · ${d.branch}` : ""}`}${d.stoppedAt ? " · stopped" : ""}`,
            }))}
          />
          <span className={cn("inline-flex items-center gap-1.5 text-[13px]", state === "live" && !paused ? "text-success" : "text-muted")}>
            <span className={cn("h-2 w-2 rounded-full", state === "live" && !paused ? "animate-pulse bg-success" : state === "error" ? "bg-danger" : "bg-subtle")} />
            {paused ? "Paused" : state === "live" ? "Live" : state === "error" ? "Reconnecting…" : "Connecting…"}
          </span>
          {containers.map((c) => (
            <Badge key={c.name} tone={c.running ? "success" : "danger"}>
              {c.service ?? `r${c.replica}`} · {c.state}
              {c.restartCount ? ` · ${c.restartCount} restarts` : ""}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" leftIcon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setClearedAt(Date.now())}>
            Clear
          </Button>
          <a
            href={`/api/v1/deployments/${depId}/runtime-logs?${params}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] hover:border-border-strong"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        </div>
      </div>

      <Card className="p-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_160px_160px_170px]">
          <Input aria-label="Search logs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" prefix={<Search className="h-4 w-4" />} />
          <Select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as "all" | Level)} options={LEVELS} />
          <Select
            aria-label="Replica"
            value={replica}
            onChange={(e) => setReplica(e.target.value)}
            options={[{ value: "all", label: "All replicas" }, ...sources.map((s) => ({ value: s, label: s.startsWith("r") && /^r\d+$/.test(s) ? `Replica ${s.slice(1)}` : s }))]}
          />
          <Select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)} options={RANGES} />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        <span>
          {filtered.length.toLocaleString()} of {lines.length.toLocaleString()} lines
        </span>
        <span className={counts.e ? "text-danger" : ""}>{counts.e} errors</span>
        <span className={counts.w ? "text-warning" : ""}>{counts.w} warnings</span>
        {dep && <span suppressHydrationWarning>Deployment created {timeAgo(dep.createdAt)}</span>}
      </div>

      <LogViewer lines={filtered} height={560} emptyText={lines.length ? "No lines match the filters" : "Waiting for logs…"} />
    </div>
  );
}
