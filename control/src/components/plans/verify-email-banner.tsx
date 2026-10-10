"use client";

import { useState } from "react";
import { MailWarning } from "lucide-react";
import { api, ApiClientError } from "@/lib/client/api";

/** Thin banner above the dashboard for unverified accounts (plans area): explains the restriction + resend link. */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);
  const resend = async () => {
    setState("busy");
    setErr(null);
    try {
      await api("/api/v1/auth/verify-email/resend", { method: "POST" });
      setState("sent");
    } catch (e) {
      setErr(e instanceof ApiClientError ? e.message : "Could not send the email");
      setState("idle");
    }
  };
  return (
    <div className="border-b border-warning/30 bg-warning/10" data-testid="verify-email-banner">
      <div className="container-page flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
        <MailWarning className="h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          Verify <span className="font-medium">{email}</span> to create projects and deploy. Check your inbox for the link.
          {err && <span className="ml-2 text-danger">{err}</span>}
        </span>
        <button type="button" onClick={resend} disabled={state !== "idle"} className="font-medium text-fg underline-offset-4 hover:underline disabled:opacity-60">
          {state === "sent" ? "Sent — check your inbox" : state === "busy" ? "Sending…" : "Resend email"}
        </button>
      </div>
    </div>
  );
}
