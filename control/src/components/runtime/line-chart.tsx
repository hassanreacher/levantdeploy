"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Dependency-free SVG time-series chart: one y-axis, 2px lines (or thin bars), recessive grid,
 * crosshair + tooltip on hover, legend for ≥ 2 series. Colours are CSS colour strings built from theme tokens.
 */
export type ChartSeries = { key: string; label: string; color: string; kind?: "line" | "bar" };
type Point = { t: number } & Record<string, number | null>;

const H_PAD = { l: 48, r: 12, t: 12, b: 24 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function LineChart({
  points,
  series,
  height = 180,
  format = (v) => String(Math.round(v)),
  stepMs,
  empty = "No data in this range yet",
}: {
  points: Point[];
  series: ChartSeries[];
  height?: number;
  format?: (v: number) => string;
  stepMs: number;
  empty?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    setW(Math.max(200, box.current.clientWidth));
    const ro = new ResizeObserver((e) => setW(Math.max(200, e[0]!.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const max = useMemo(() => niceMax(Math.max(0, ...points.flatMap((p) => series.map((s) => p[s.key] ?? 0)))), [points, series]);
  const hasData = points.some((p) => series.some((s) => p[s.key] !== null && p[s.key] !== undefined && (p[s.key] ?? 0) > 0));
  const iw = w - H_PAD.l - H_PAD.r;
  const ih = height - H_PAD.t - H_PAD.b;
  const n = points.length;
  const x = (i: number) => H_PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => H_PAD.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const timeFmt = (t: number) =>
    new Date(t).toLocaleString([], stepMs >= 3600_000 ? { month: "short", day: "numeric", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const xLabels = n ? [0, Math.floor((n - 1) / 2), n - 1] : [];

  return (
    <div ref={box} className="relative w-full min-w-0 overflow-hidden" style={{ minHeight: height }}>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {w > 0 && (
      <svg
        width={w}
        height={height}
        role="img"
        aria-label={series.map((s) => s.label).join(", ")}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left - H_PAD.l;
          if (n === 0) return;
          setHover(Math.max(0, Math.min(n - 1, Math.round((px / iw) * (n - 1)))));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={H_PAD.l} x2={w - H_PAD.r} y1={y(t)} y2={y(t)} stroke="rgb(var(--border))" strokeWidth={1} />
            <text x={H_PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="rgb(var(--subtle))">
              {format(t)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={11} fill="rgb(var(--subtle))">
            {timeFmt(points[i]!.t)}
          </text>
        ))}
        {hasData &&
          series.map((s, si) => {
            if (s.kind === "bar") {
              const bw = Math.max(1, Math.min(10, iw / Math.max(n, 1) - 2));
              return (
                <g key={s.key}>
                  {points.map((p, i) => {
                    const v = p[s.key] ?? 0;
                    if (v <= 0) return null;
                    const top = y(v);
                    return <rect key={i} x={x(i) - bw / 2 + si * 0} y={top} width={bw} height={Math.max(1, H_PAD.t + ih - top)} rx={Math.min(2, bw / 2)} fill={s.color} />;
                  })}
                </g>
              );
            }
            // null/undefined = no sample → gap in the line
            let pen = false;
            let d = "";
            points.forEach((p, i) => {
              const v = p[s.key];
              if (v === null || v === undefined) {
                pen = false;
                return;
              }
              d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
              pen = true;
            });
            return <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
          })}
        {hover !== null && hasData && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={H_PAD.t} y2={H_PAD.t + ih} stroke="rgb(var(--border-strong))" strokeWidth={1} />
            {series
              .filter((s) => s.kind !== "bar" && points[hover]![s.key] !== null && points[hover]![s.key] !== undefined)
              .map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(points[hover]![s.key] ?? 0)} r={4} fill={s.color} stroke="rgb(var(--surface))" strokeWidth={2} />
              ))}
          </g>
        )}
      </svg>
      )}
      {!hasData && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-subtle">{empty}</div>}
      {hover !== null && hasData && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-pop"
          style={{ left: Math.min(Math.max(x(hover) + 10, 0), w - 170), top: 8 }}
        >
          <div className="mb-0.5 text-subtle">{timeFmt(points[hover]!.t)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-mono text-fg">{points[hover]![s.key] === null || points[hover]![s.key] === undefined ? "—" : format(points[hover]![s.key]!)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
