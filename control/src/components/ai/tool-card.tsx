"use client";

import { useState } from "react";
import {
  Activity,
  Ban,
  Check,
  ChevronRight,
  Clock,
  Database,
  FileCode2,
  FileSearch,
  Globe,
  KeyRound,
  ListTree,
  RefreshCw,
  Rocket,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Stethoscope,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import type { UiAction } from "@/lib/ai/types";
import { Button, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  list_projects: ListTree,
  get_project: Settings2,
  list_deployments: Rocket,
  get_deployment: Rocket,
  get_build_logs: Terminal,
  get_runtime_logs: Terminal,
  get_metrics: Activity,
  diagnose_deployment: Stethoscope,
  check_domain_dns: Globe,
  explain_dns_setup: Globe,
  read_repo_file: FileSearch,
  generate_dockerfile: FileCode2,
  set_env_var: KeyRound,
  delete_env_var: KeyRound,
  update_build_settings: Settings2,
  update_runtime_settings: Settings2,
  redeploy: Rocket,
  rollback: RotateCcw,
  restart: RefreshCw,
  add_domain: Globe,
  create_database: Database,
};

const LABEL: Record<string, string> = {
  PENDING_APPROVAL: "Needs approval",
  APPROVED: "Approved",
  RUNNING: "Running",
  SUCCEEDED: "Done",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

function StatusIcon({ status }: { status: UiAction["status"] | "STREAMING" }) {
  if (status === "RUNNING" || status === "APPROVED" || status === "STREAMING") return <Spinner className="h-3.5 w-3.5" />;
  if (status === "SUCCEEDED") return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === "FAILED") return <X className="h-3.5 w-3.5 text-danger" />;
  if (status === "REJECTED") return <Ban className="h-3.5 w-3.5 text-subtle" />;
  return <Clock className="h-3.5 w-3.5 text-warning" />;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.map(String).join(", ");
  return JSON.stringify(v);
}

/** A compact row describing one tool call ("Read build logs matching …") with expandable input/output. */
export function ToolCard({ name, input, action, streaming }: { name: string; input: Record<string, unknown>; action?: UiAction; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[name] ?? Terminal;
  const status = action?.status ?? (streaming ? "STREAMING" : "RUNNING");
  const shownInput = action?.input ?? input;
  const output = typeof action?.output === "string" ? action.output : action?.error ?? null;
  return (
    <div className={cn("rounded-lg border bg-surface text-[13px]", action?.status === "FAILED" ? "border-danger/30" : "border-border")}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open}>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-fg">{action?.summary ?? name.replace(/_/g, " ")}</span>
        <span className="hidden font-mono text-[11px] text-subtle sm:inline">{name}</span>
        <StatusIcon status={status} />
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          {Object.keys(shownInput).length > 0 && (
            <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1">
              {Object.entries(shownInput).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-[11.5px] text-subtle">{k}</dt>
                  <dd className="min-w-0 break-all font-mono text-[11.5px] text-fg">{fmt(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {output && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-subtle p-2 font-mono text-[11.5px] leading-relaxed text-muted">{output}</pre>}
          {!output && action && <p className="text-[12px] text-subtle">{LABEL[action.status]}</p>}
        </div>
      )}
    </div>
  );
}

/** Approve / Reject card for a proposed (mutating) action. Destructive ones require typing `confirmText`. */
export function ApprovalCard({ action, disabled, onApprove, onReject }: { action: UiAction; disabled?: boolean; onApprove: (confirm?: string) => Promise<void> | void; onReject: () => Promise<void> | void }) {
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const Icon = ICONS[action.tool] ?? Settings2;
  const destructive = !!action.confirmText;
  const ready = !destructive || confirm.trim() === action.confirmText;
  const details = Object.entries(action.input).filter(([k, v]) => k !== "project" && v !== undefined);
  const run = async (kind: "approve" | "reject") => {
    setPending(kind);
    try {
      await (kind === "approve" ? onApprove(destructive ? confirm.trim() : undefined) : onReject());
    } catch {
      /* surfaced as a notice */
    } finally {
      setPending(null);
    }
  };
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-surface", destructive ? "border-danger/40" : "border-accent/40")} data-testid="approval-card">
      <div className={cn("flex items-center gap-2 border-b px-3.5 py-2 text-[12px] font-medium", destructive ? "border-danger/30 bg-danger/10 text-danger" : "border-accent/25 bg-accent/10 text-accent")}>
        {destructive ? <ShieldAlert className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
        {destructive ? "Destructive action — confirmation required" : "Approval required"}
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2">
            <Icon className="h-3.5 w-3.5 text-fg" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-fg">{action.summary}</p>
            <p className="font-mono text-[11.5px] text-subtle">{action.tool}</p>
          </div>
        </div>
        {details.length > 0 && (
          <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-[11.5px] text-subtle">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-[11.5px] text-fg">{fmt(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {destructive && (
          <label className="block space-y-1.5">
            <span className="text-[12.5px] text-muted">
              Type <span className="font-mono text-fg">{action.confirmText}</span> to confirm
            </span>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={action.confirmText ?? ""} className="font-mono" aria-label="Confirmation text" />
          </label>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => run("reject")} disabled={disabled || !!pending} loading={pending === "reject"}>
            Reject
          </Button>
          <Button size="sm" variant={destructive ? "danger" : "primary"} onClick={() => run("approve")} disabled={disabled || !!pending || !ready} loading={pending === "approve"} leftIcon={<Check className="h-3.5 w-3.5" />}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
