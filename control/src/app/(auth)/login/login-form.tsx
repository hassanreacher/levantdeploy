"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";
import { AuthHeading, FormError } from "../auth-form";

export function LoginForm({ next, reset }: { next?: string; reset?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ redirect: string }>("/api/v1/auth/login", { body: { email, password, next } });
      router.push(res.redirect);
      router.refresh();
    } catch (e) {
      setErr(e instanceof ApiClientError ? e.message : "Could not sign in");
      setBusy(false);
    }
  };

  return (
    <>
      <AuthHeading title="Log in to LevantDeploy" subtitle={reset ? "Your password was reset. Log in with the new one." : "Deploy anything to your own server."} />
      <form onSubmit={submit} className="space-y-4">
        <FormError message={err} />
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
        </Field>
        <Field
          label={
            <span className="flex items-center justify-between">
              Password
              <Link href="/forgot-password" className="text-[12px] font-normal text-muted hover:text-fg">
                Forgot password?
              </Link>
            </span>
          }
          htmlFor="password"
        >
          <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Continue
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="link">
          Sign up
        </Link>
      </p>
    </>
  );
}
