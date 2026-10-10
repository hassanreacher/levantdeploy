"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client/api";
import type { SignupPolicy } from "@/lib/plans/signup";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[13px] text-muted">{hint}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function SignupsSettings({ policy: p, stats }: { policy: SignupPolicy; stats: { recent: number; unverified: number } }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [registration, setRegistration] = useState(p.registration);
  const [verify, setVerify] = useState(p.requireEmailVerification);
  const [blockDisposable, setBlockDisposable] = useState(p.blockDisposableEmails);
  const [extra, setExtra] = useState(p.disposableDomains.join("\n"));
  const [limit, setLimit] = useState(String(p.signupRateLimit.limit));
  const [windowMin, setWindowMin] = useState(String(p.signupRateLimit.windowMinutes));
  const [terms, setTerms] = useState(p.requireTerms);
  const [termsUrl, setTermsUrl] = useState(p.termsUrl ?? "");
  const [privacyUrl, setPrivacyUrl] = useState(p.privacyUrl ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});

  const save = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setFields({});
    try {
      await api("/api/v1/platform/signups", { method: "PATCH", body });
      toast.success("Saved");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError && e.fields) setFields(e.fields);
      toast.error("Could not save", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader title="Registration" description={`${stats.recent} account${stats.recent === 1 ? "" : "s"} created in the last 7 days · ${stats.unverified} unverified.`} />
        <CardBody className="space-y-5">
          <Select
            className="max-w-sm"
            aria-label="Registration mode"
            value={registration}
            disabled={p.lockedByEnv}
            onChange={(e) => setRegistration(e.target.value as SignupPolicy["registration"])}
            options={[
              { value: "open", label: "Open — anyone can sign up" },
              { value: "invite", label: "Invite only — through team invites" },
              { value: "closed", label: "Closed — no new accounts" },
            ]}
          />
          <Row title="Require email verification" hint="Unverified users can sign in but can't create projects, backends or deployments until they click the emailed link.">
            <Switch checked={verify} onCheckedChange={setVerify} label="Require email verification" />
          </Row>
        </CardBody>
        <CardFooter hint={p.lockedByEnv ? "Forced to open by REGISTRATION=open in .env." : "New accounts get the default plan."}>
          <Button size="sm" variant="primary" loading={busy === "reg"} disabled={registration === p.registration && verify === p.requireEmailVerification} onClick={() => save("reg", { registration, requireEmailVerification: verify })}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Abuse protection" description="Limits for open registration." />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sign-ups per IP" htmlFor="rl-limit" error={fields["signupRateLimit.limit"]}>
              <Input id="rl-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} suffix="accounts" />
            </Field>
            <Field label="Window" htmlFor="rl-window" error={fields["signupRateLimit.windowMinutes"]}>
              <Input id="rl-window" inputMode="numeric" value={windowMin} onChange={(e) => setWindowMin(e.target.value)} suffix="min" />
            </Field>
          </div>
          <Row title="Block disposable email addresses" hint="Rejects sign-ups from known throwaway providers (built-in list of 70+ domains plus yours). Invites are not affected.">
            <Switch checked={blockDisposable} onCheckedChange={setBlockDisposable} label="Block disposable emails" />
          </Row>
          <Field label="Extra blocked domains" htmlFor="dd" hint="One per line." error={Object.entries(fields).find(([k]) => k.startsWith("disposableDomains"))?.[1]}>
            <Textarea id="dd" rows={3} className="font-mono" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="spam-provider.example" />
          </Field>
        </CardBody>
        <CardFooter>
          <Button
            size="sm"
            variant="primary"
            loading={busy === "abuse"}
            onClick={() =>
              save("abuse", {
                signupRateLimit: { limit: Number(limit), windowMinutes: Number(windowMin) },
                blockDisposableEmails: blockDisposable,
                disposableDomains: extra
                  .split(/[\s,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          >
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Terms" description="A checkbox on the sign-up form. Links are shown when set." />
        <CardBody className="space-y-5">
          <Row title="Require accepting the terms" hint="New accounts must tick “I agree to the Terms of Service”.">
            <Switch checked={terms} onCheckedChange={setTerms} label="Require terms" />
          </Row>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Terms of Service URL" htmlFor="terms" error={fields.termsUrl}>
              <Input id="terms" value={termsUrl} onChange={(e) => setTermsUrl(e.target.value)} placeholder="https://example.com/terms" />
            </Field>
            <Field label="Privacy Policy URL" htmlFor="privacy" error={fields.privacyUrl}>
              <Input id="privacy" value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://example.com/privacy" />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <Button size="sm" variant="primary" loading={busy === "terms"} onClick={() => save("terms", { requireTerms: terms, termsUrl, privacyUrl })}>
            Save
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}
