import { Check, X, Ban, Circle } from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";
import { Elapsed } from "./time-ago";

type Ev = { status: string; createdAt: string; message: string | null };
const STEPS = [
  { key: "QUEUED", label: "Queued" },
  { key: "BUILDING", label: "Building" },
  { key: "DEPLOYING", label: "Deploying" },
  { key: "READY", label: "Ready" },
] as const;

/**
 * QUEUED → BUILDING → DEPLOYING → READY progress built from DeploymentEvent rows.
 * Failed/canceled deployments mark the step where they stopped. Horizontal on desktop, vertical on mobile.
 */
export function StatusTimeline({ status, events, createdAt }: { status: string; events: Ev[]; createdAt: string }) {
  const first = (s: string) => events.find((e) => e.status === s);
  const failed = status === "ERROR" || status === "CANCELED";
  const endEv = failed ? first(status) : null;
  // the step a failed deployment stopped in = last step reached before the failure
  const reached = STEPS.map((s) => !!first(s.key) || (s.key === "QUEUED"));
  const lastReached = reached.lastIndexOf(true);
  const ready = status === "READY" || status === "SUPERSEDED" || !!first("READY");
  return (
    <ol className="grid gap-3 sm:grid-cols-4 sm:gap-0" aria-label="Deployment progress">
      {STEPS.map((s, i) => {
        const ev = s.key === "QUEUED" ? (first("QUEUED") ?? { createdAt, status: "QUEUED", message: null }) : first(s.key);
        const nextEv = STEPS.slice(i + 1).map((x) => first(x.key)).find(Boolean) ?? null;
        const stopAt = endEv && i === lastReached ? endEv : null;
        const done = !!ev && (!!nextEv || (s.key === "READY" && ready));
        const active = !!ev && !done && !stopAt && !failed && !ready;
        const state: "done" | "active" | "failed" | "canceled" | "todo" = stopAt ? (status === "ERROR" ? "failed" : "canceled") : done ? "done" : active ? "active" : s.key === "READY" && ready ? "done" : "todo";
        const end = nextEv?.createdAt ?? stopAt?.createdAt ?? null;
        return (
          <li key={s.key} className="relative flex items-start gap-3 sm:flex-col sm:gap-2 sm:pr-4">
            {i < STEPS.length - 1 && (
              <span aria-hidden className={cn("absolute left-[11px] top-7 h-[calc(100%-4px)] w-px sm:left-7 sm:right-2 sm:top-[11px] sm:h-px sm:w-auto", done ? "bg-success/50" : "bg-border")} />
            )}
            <span
              className={cn(
                "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                state === "done" && "border-success/40 bg-success/15 text-success",
                state === "active" && "border-warning/50 bg-warning/15 text-warning",
                state === "failed" && "border-danger/50 bg-danger/15 text-danger",
                state === "canceled" && "border-border-strong bg-surface-2 text-muted",
                state === "todo" && "border-border bg-surface text-subtle",
              )}
            >
              {state === "done" ? (
                <Check className="h-3.5 w-3.5" />
              ) : state === "failed" ? (
                <X className="h-3.5 w-3.5" />
              ) : state === "canceled" ? (
                <Ban className="h-3 w-3" />
              ) : state === "active" ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-warning" />
              ) : (
                <Circle className="h-2 w-2" />
              )}
            </span>
            <div className="min-w-0">
              <p className={cn("text-[13px] font-medium", state === "todo" ? "text-subtle" : state === "failed" ? "text-danger" : "text-fg")}>
                {state === "failed" ? `${s.label} failed` : state === "canceled" ? `Canceled while ${s.label.toLowerCase()}` : s.label}
              </p>
              <p className="font-mono text-[12px] text-muted" suppressHydrationWarning>
                {ev ? new Date(ev.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}
                {ev && s.key !== "READY" && (end ? ` · ${formatDuration(new Date(end).getTime() - new Date(ev.createdAt).getTime())}` : active ? <> · <Elapsed from={ev.createdAt} /></> : null)}
              </p>
              {stopAt?.message && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{stopAt.message}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
