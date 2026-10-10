import { cn } from "@/lib/utils";
import { fmtLimit, fmtValue, tone, type UsageUnit } from "./format";

export type UsageBarItem = { resource: string; label: string; used: number; limit: number | null; unit: UsageUnit; ratio: number; enforced: boolean };

const BAR: Record<ReturnType<typeof tone>, string> = { accent: "bg-accent", warning: "bg-warning", danger: "bg-danger", muted: "bg-border-strong" };

/** One resource row: label, used / limit and a progress bar (warning ≥ 80 %, danger ≥ 100 %). Server-safe. */
export function UsageBar({ item, hint, className }: { item: UsageBarItem; hint?: string; className?: string }) {
  const limited = item.limit !== null;
  const t = tone(item.ratio, limited);
  const pct = limited ? Math.min(100, Math.max(item.used > 0 ? 2 : 0, item.ratio * 100)) : 0;
  return (
    <div className={cn("min-w-0", className)} data-resource={item.resource}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="truncate text-fg">{item.label}</span>
        <span className="shrink-0 tabular-nums text-muted">
          <span className={cn("font-medium", t === "danger" ? "text-danger" : t === "warning" ? "text-warning" : "text-fg")}>{fmtValue(item.used, item.unit)}</span>
          {" / "}
          {fmtLimit(item.limit, item.unit)}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={item.label}
        aria-valuemin={0}
        aria-valuemax={limited ? 100 : undefined}
        aria-valuenow={limited ? Math.round(item.ratio * 100) : undefined}
      >
        {limited ? <div className={cn("h-full rounded-full transition-[width]", BAR[t])} style={{ width: `${pct}%` }} /> : <div className="h-full w-full bg-border-strong/30" />}
      </div>
      {(hint || (limited && item.ratio >= 1)) && (
        <p className={cn("mt-1 text-[12px]", item.ratio >= 1 ? "text-danger" : "text-subtle")}>
          {item.ratio >= 1 ? (item.enforced ? "Limit reached — new usage is restricted." : "Over the limit (warning only).") : hint}
        </p>
      )}
    </div>
  );
}
