"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api, ApiClientError } from "@/lib/client/api";
import { Spinner } from "@/components/ui/spinner";
import { AuthHeading, FormError } from "../auth-form";

export function VerifyEmail({ token, signedIn }: { token: string | null; signedIn: boolean }) {
  const [state, setState] = useState<{ kind: "busy" } | { kind: "ok"; email: string } | { kind: "error"; message: string }>(
    token ? { kind: "busy" } : { kind: "error", message: "This link is missing its token. Open the link from the email again." },
  );
  const once = useRef(false);
  useEffect(() => {
    if (!token || once.current) return;
    once.current = true;
    api<{ ok: true; email: string }>("/api/v1/auth/verify-email", { body: { token } })
      .then((r) => setState({ kind: "ok", email: r.email }))
      .catch((e) => setState({ kind: "error", message: e instanceof ApiClientError ? e.message : "Could not verify your email" }));
  }, [token]);

  if (state.kind === "busy")
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted">
        <Spinner />
        Verifying your email…
      </div>
    );
  if (state.kind === "ok")
    return (
      <>
        <div className="mb-4 flex justify-center text-success">
          <CheckCircle2 className="h-8 w-8" />
        </div>
        <AuthHeading title="Email verified" subtitle={`${state.email} is confirmed. You can create projects and deploy now.`} />
        <p className="text-center text-sm">
          <Link href={signedIn ? "/" : "/login"} className="link" data-testid="verified-continue">
            {signedIn ? "Go to the dashboard" : "Log in"}
          </Link>
        </p>
      </>
    );
  return (
    <>
      <AuthHeading title="Verification failed" subtitle="We couldn't verify your email address." />
      <FormError message={state.message} />
      <p className="mt-6 text-center text-sm">
        <Link href={signedIn ? "/" : "/login"} className="link">
          {signedIn ? "Back to the dashboard — resend from the banner" : "Log in to resend the email"}
        </Link>
      </p>
    </>
  );
}
