"use client";

import Link from "next/link";
import { useState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";
import { AuthHeading, FormError } from "../auth-form";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface">
          <MailCheck className="h-5 w-5 text-success" />
        </div>
        <AuthHeading title="Check your inbox" subtitle={`If an account exists for ${email}, we sent a reset link. It expires in 1 hour.`} />
        <Link href="/login" className="link text-sm">
          Back to log in
        </Link>
      </div>
    );
  }
  return (
    <>
      <AuthHeading title="Reset your password" subtitle="We'll email you a link to choose a new one." />
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api("/api/v1/auth/forgot-password", { body: { email } });
            setSent(true);
          } catch (e) {
            setErr(e instanceof ApiClientError ? e.message : "Something went wrong");
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormError message={err} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Send reset link
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-muted">
        <Link href="/login" className="link">
          Back to log in
        </Link>
      </p>
    </>
  );
}
