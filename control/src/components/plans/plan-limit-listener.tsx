"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, MailWarning, X } from "lucide-react";
import { api, PLAN_LIMIT_EVENT } from "@/lib/client/api";
import { Button } from "@/components/ui/button";

type Detail = { code: "PLAN_LIMIT" | "EMAIL_UNVERIFIED"; message: string; resource?: string; limit?: number | null; used?: number; plan?: { name: string }; upgradeUrl?: string | null };

/**
 * Global banner for plan-limit errors (plans area). `api()` dispatches PLAN_LIMIT_EVENT for every 402 PLAN_LIMIT /
 * 403 EMAIL_UNVERIFIED response, so any dashboard action that hits a limit explains it and links to Plan & Usage —
 * on top of the action's own error toast. Mounted once in the team layout.
 */
export function PlanLimitListener({ team }: { team: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [sent, setSent] = useState<"idle" | "busy" | "sent" | "error">("idle");
  useEffect(() => {
    const on = (e: Event) => {
      setD((e as CustomEvent<Detail>).detail);
      setSent("idle");
    };
    window.addEventListener(PLAN_LIMIT_EVENT, on);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, on);
  }, []);
  if (!d) return null;
  const unverified = d.code === "EMAIL_UNVERIFIED";
  const resend = async () => {
    setSent("busy");
    try {
      await api("/api/v1/auth/verify-email/resend", { method: "POST" });
      setSent("sent");
    } catch {
      setSent("error");
    }
  };
  return (
    <div role="alert" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl rounded-xl border border-warning/40 bg-surface p-4 shadow-pop sm:inset-x-auto sm:left-1/2 sm:w-[36rem] sm:-translate-x-1/2" data-testid="plan-limit-banner">
      <div className="flex gap-3">
        <span className="mt-0.5 text-warning">{unverified ? <MailWarning className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{unverified ? "Verify your email to continue" : `${d.plan?.name ?? "Plan"} limit reached`}</p>
          <p className="mt-1 text-[13px] text-muted">{d.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {unverified ? (
              <Button size="sm" variant="primary" loading={sent === "busy"} disabled={sent === "sent"} onClick={resend}>
                {sent === "sent" ? "Email sent" : sent === "error" ? "Try again" : "Resend verification email"}
              </Button>
            ) : (
              <Link href={d.upgradeUrl || `/${team}/settings/plan`} onClick={() => setD(null)} className="inline-flex h-8 items-center rounded-md bg-fg px-3 text-[13px] font-medium text-bg hover:opacity-90">
                View Plan &amp; Usage
              </Link>
            )}
          </div>
        </div>
        <button type="button" aria-label="Dismiss" onClick={() => setD(null)} className="h-6 w-6 shrink-0 rounded text-muted hover:bg-surface-2 hover:text-fg">
          <X className="mx-auto h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
