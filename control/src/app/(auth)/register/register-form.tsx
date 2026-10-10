"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";
import { AuthHeading, FormError } from "../auth-form";

export function RegisterForm({
  firstUser,
  open,
  invite,
  closed = false,
  terms = null,
}: {
  firstUser: boolean;
  open: boolean;
  invite?: string;
  /** plans area: registration closed (no new accounts, even with an invite) */
  closed?: boolean;
  /** plans area: terms checkbox (null = not required) */
  terms?: { termsUrl: string | null; privacyUrl: string | null } | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  if (closed) {
    return (
      <>
        <AuthHeading title="Registration closed" subtitle="This LevantDeploy instance isn't accepting new accounts right now." />
        <p className="text-center text-sm">
          <Link href="/login" className="link">
            Back to log in
          </Link>
        </p>
      </>
    );
  }

  if (!open && !invite) {
    return (
      <>
        <AuthHeading title="Invite only" subtitle="Ask a team owner on this LevantDeploy instance for an invite link." />
        <p className="text-center text-sm">
          <Link href="/login" className="link">
            Back to log in
          </Link>
        </p>
      </>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setFields({});
    try {
      const res = await api<{ redirect: string }>("/api/v1/auth/register", { body: { ...form, inviteToken: invite, acceptTerms: accept } });
      router.push(res.redirect);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        setErr(e.fields ? null : e.message);
        setFields(e.fields ?? {});
      } else setErr("Could not create your account");
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <AuthHeading
        title={firstUser ? "Set up LevantDeploy" : "Create your account"}
        subtitle={firstUser ? "The first account becomes the platform owner." : "Deploy anything to your own server."}
      />
      <form onSubmit={submit} className="space-y-4">
        <FormError message={err} />
        <Field label="Name" htmlFor="name" error={fields.name}>
          <Input id="name" required value={form.name} onChange={set("name")} autoComplete="name" autoFocus />
        </Field>
        <Field label="Email" htmlFor="email" error={fields.email}>
          <Input id="email" type="email" required value={form.email} onChange={set("email")} autoComplete="email" />
        </Field>
        <Field label="Password" htmlFor="password" error={fields.password} hint="At least 8 characters with a letter and a number.">
          <Input id="password" type="password" required value={form.password} onChange={set("password")} autoComplete="new-password" />
        </Field>
        {terms && (
          <div>
            <label className="flex items-start gap-2 text-[13px] text-muted">
              <input
                id="acceptTerms"
                type="checkbox"
                checked={accept}
                onChange={(e) => setAccept(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
                required
              />
              <span>
                I agree to the{" "}
                {terms.termsUrl ? (
                  <a href={terms.termsUrl} target="_blank" rel="noreferrer" className="link">
                    Terms of Service
                  </a>
                ) : (
                  "Terms of Service"
                )}
                {terms.privacyUrl && (
                  <>
                    {" "}
                    and the{" "}
                    <a href={terms.privacyUrl} target="_blank" rel="noreferrer" className="link">
                      Privacy Policy
                    </a>
                  </>
                )}
                .
              </span>
            </label>
            {fields.acceptTerms && <p className="mt-1 text-[12px] text-danger">{fields.acceptTerms}</p>}
          </div>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {firstUser ? "Create owner account" : "Create account"}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="link">
          Log in
        </Link>
      </p>
    </>
  );
}
