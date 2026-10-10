"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";
import { AuthHeading, FormError } from "../auth-form";

export function TwoFactorForm({ next }: { next?: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface">
        <ShieldCheck className="h-5 w-5" />
      </div>
      <AuthHeading
        title="Two-factor authentication"
        subtitle={recovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}
      />
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await api<{ redirect: string }>("/api/v1/auth/2fa", { body: { code, next } });
            router.push(r.redirect);
            router.refresh();
          } catch (e) {
            setErr(e instanceof ApiClientError ? e.message : "Verification failed");
            setBusy(false);
          }
        }}
      >
        <FormError message={err} />
        <Field label={recovery ? "Recovery code" : "Authentication code"} htmlFor="code">
          <Input
            id="code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={recovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
            className="text-center font-mono text-lg tracking-[0.3em]"
            autoFocus
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Verify
        </Button>
      </form>
      <div className="mt-6 flex justify-between text-sm text-muted">
        <button className="hover:text-fg" onClick={() => setRecovery((r) => !r)}>
          {recovery ? "Use authenticator code" : "Use a recovery code"}
        </button>
        <Link href="/login" className="hover:text-fg">
          Cancel
        </Link>
      </div>
    </>
  );
}
