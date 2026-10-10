"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";
import { AuthHeading, FormError } from "../auth-form";

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!token) {
    return (
      <>
        <AuthHeading title="Invalid link" subtitle="This reset link is missing its token." />
        <p className="text-center">
          <Link href="/forgot-password" className="link text-sm">
            Request a new link
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <AuthHeading title="Choose a new password" subtitle="All your other sessions will be signed out." />
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirm) return setErr("Passwords don't match");
          setBusy(true);
          setErr(null);
          try {
            const r = await api<{ redirect: string }>("/api/v1/auth/reset-password", { body: { token, password } });
            router.push(r.redirect);
          } catch (e) {
            setErr(e instanceof ApiClientError ? (e.fields?.password ?? e.message) : "Something went wrong");
            setBusy(false);
          }
        }}
      >
        <FormError message={err} />
        <Field label="New password" htmlFor="password" hint="At least 8 characters with a letter and a number.">
          <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <Input id="confirm" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Reset password
        </Button>
      </form>
    </>
  );
}
