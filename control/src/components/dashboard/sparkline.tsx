import { cn } from "@/lib/utils";

/** Tiny inline-SVG area sparkline (server-safe). Uses currentColor. */
export function Sparkline({ data, width = 120, height = 32, className, label }: { data: number[]; width?: number; height?: number; className?: string; label?: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = `sg${Math.abs(data.reduce((a, b) => (a * 31 + b) | 0, 7))}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cn("overflow-visible", className)} role="img" aria-label={label ?? "trend"} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Simple vertical bar chart (server-safe). */
export function BarChart({ data, height = 120, className, format = (n: number) => String(n) }: { data: { label: string; value: number }[]; height?: number; className?: string; format?: (n: number) => string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className={cn("flex items-end gap-[3px]", className)} style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="group relative flex h-full flex-1 items-end" title={`${d.label}: ${format(d.value)}`}>
          <div className="w-full rounded-sm bg-accent/70 transition-colors group-hover:bg-accent" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}
