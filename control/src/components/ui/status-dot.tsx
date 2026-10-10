import { cn } from "@/lib/utils";

export type DeploymentStatusName = "QUEUED" | "BUILDING" | "DEPLOYING" | "READY" | "ERROR" | "CANCELED" | "SUPERSEDED";

/** Vercel-style colours: queued grey, building amber (pulsing), ready green, error red. */
export const STATUS_STYLE: Record<DeploymentStatusName, { dot: string; text: string; label: string; pulse?: boolean }> = {
  QUEUED: { dot: "bg-subtle", text: "text-muted", label: "Queued" },
  BUILDING: { dot: "bg-warning", text: "text-warning", label: "Building", pulse: true },
  DEPLOYING: { dot: "bg-warning", text: "text-warning", label: "Deploying", pulse: true },
  READY: { dot: "bg-success", text: "text-success", label: "Ready" },
  ERROR: { dot: "bg-danger", text: "text-danger", label: "Error" },
  CANCELED: { dot: "bg-subtle", text: "text-subtle", label: "Canceled" },
  SUPERSEDED: { dot: "bg-border-strong", text: "text-subtle", label: "Superseded" },
};

export function StatusDot({ status, withLabel, className }: { status: DeploymentStatusName; withLabel?: boolean; className?: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.QUEUED;
  return (
    <span className={cn("inline-flex items-center gap-2", className)} title={s.label}>
      <span className="relative inline-flex h-2.5 w-2.5">
        {s.pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", s.dot)} />}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", s.dot)} />
      </span>
      {withLabel && <span className={cn("text-[13px] font-medium", s.text)}>{s.label}</span>}
    </span>
  );
}
