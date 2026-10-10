"use client";

import type { DiffLine } from "@/lib/builder-ui/diff";
import { cn } from "@/lib/utils";

/** Unified diff lines (green/red gutters, line numbers). `compact` hides the old/new number columns. */
export function DiffView({ lines, compact, className, maxLines }: { lines: DiffLine[]; compact?: boolean; className?: string; maxLines?: number }) {
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  const rest = maxLines ? lines.length - shown.length : 0;
  if (!lines.length) return <p className="px-3 py-2 text-[12px] text-subtle">No textual changes.</p>;
  return (
    <div className={cn("overflow-x-auto font-mono text-[11.5px] leading-[1.6]", className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((l, i) =>
            l.kind === "hunk" || l.kind === "meta" ? (
              <tr key={i} className="bg-surface-2/60 text-subtle">
                <td colSpan={compact ? 2 : 4} className="px-3 py-0.5">
                  {l.text}
                </td>
              </tr>
            ) : (
              <tr key={i} className={cn(l.kind === "add" && "bg-success/10", l.kind === "del" && "bg-danger/10")}>
                {!compact && <td className="w-10 select-none pr-2 text-right text-subtle/70">{l.oldNo ?? ""}</td>}
                {!compact && <td className="w-10 select-none pr-2 text-right text-subtle/70">{l.newNo ?? ""}</td>}
                <td className={cn("w-4 select-none pl-2 text-center", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-danger" : "text-subtle")}>
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </td>
                <td className="whitespace-pre pr-3 text-fg/90">{l.text || " "}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {rest > 0 && <p className="px-3 py-1 text-[11px] text-subtle">… {rest} more lines</p>}
    </div>
  );
}

export function DiffStat({ additions = 0, deletions = 0 }: { additions?: number; deletions?: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-success">+{additions}</span> <span className="text-danger">−{deletions}</span>
    </span>
  );
}
