"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Mail, Send } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CopyButton, Field, Input, Select, Switch, Textarea, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { EMAIL_TEMPLATES, OAUTH_PROVIDERS, type AuthSettingsView } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";

type Patch = Record<string, unknown>;

function useSave(refId: string, setSettings: (s: AuthSettingsView) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = async (key: string, patch: Patch, ok = "Saved") => {
    setBusy(key);
    setErrors({});
    try {
      const r = await api<{ settings: AuthSettingsView; applying: boolean }>(`/api/v1/base/projects/${refId}/auth`, { method: "PATCH", body: patch });
      setSettings(r.settings);
      toast.success(ok, r.applying ? "Applying — Auth restarts in a few seconds." : "Applied when the project starts.");
      return true;
    } catch (e) {
      const err = e as ApiClientError;
      if (err.fields) setErrors(err.fields);
      toast.error("Could not save", err.fields ? Object.values(err.fields)[0] : err.message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, save, errors };
}

function Row({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {description && <div className="mt-0.5 text-[12px] text-muted">{description}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function AuthSettingsClient({ refId, apiUrl, initial, canEdit }: { refId: string; apiUrl: string; initial: AuthSettingsView; canEdit: boolean }) {
  const [settings, setSettings] = useState(initial);
  const { busy, save, errors } = useSave(refId, setSettings);
  const toast = useToast();

  // URL configuration
  const [siteUrl, setSiteUrl] = useState(initial.auth.siteUrl);
  const [redirects, setRedirects] = useState(initial.auth.additionalRedirectUrls.join("\n"));
  // providers
  const [a, setA] = useState(initial.auth);
  // SMTP
  const [smtp, setSmtp] = useState({ ...initial.smtp, pass: "" });
  const [testTo, setTestTo] = useState("");
  // templates
  const [tpl, setTpl] = useState<string>(EMAIL_TEMPLATES[0].id);
  const [tpls, setTpls] = useState(() => Object.fromEntries(EMAIL_TEMPLATES.map((t) => [t.id, initial.templates[t.id] ?? { subject: "", body: "" }])));

  const callback = `${apiUrl}/auth/v1/callback`;
  const dirtyAuth = JSON.stringify(a) !== JSON.stringify(settings.auth);

  return (
    <div className="max-w-3xl space-y-6">
      {!canEdit && <div className="rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-muted">Only admins can change authentication settings.</div>}

      <Card>
        <CardHeader title="URL configuration" description="Where users land after confirming their email or signing in with OAuth, and which redirect URLs your apps may request." />
        <CardBody className="space-y-4">
          <Field label="Site URL" hint="Default redirect URL and the base of links in auth emails." error={errors["auth.siteUrl"]}>
            <Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.com" disabled={!canEdit} className="font-mono" />
          </Field>
          <Field label="Redirect URLs" hint="One per line. Wildcards are allowed, e.g. https://*.example.com/** or http://localhost:3000/**" error={errors["auth.additionalRedirectUrls"]}>
            <Textarea value={redirects} onChange={(e) => setRedirects(e.target.value)} rows={4} disabled={!canEdit} className="font-mono text-[13px]" placeholder="https://app.example.com/auth/callback" />
          </Field>
        </CardBody>
        <CardFooter hint="Changes restart the Auth service.">
          <Button
            size="sm"
            variant="primary"
            disabled={!canEdit}
            loading={busy === "urls"}
            onClick={() =>
              save("urls", {
                auth: {
                  siteUrl: siteUrl.trim(),
                  additionalRedirectUrls: redirects
                    .split(/\n|,/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              })
            }
          >
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Sign-in methods" description="Which ways users can sign up and sign in." />
        <CardBody className="divide-y divide-border py-2">
          <Row title="Allow new users to sign up" description="When off, only users you invite (or create with the service key) can sign in.">
            <Switch checked={!a.disableSignup} onCheckedChange={(v) => setA({ ...a, disableSignup: !v })} disabled={!canEdit} label="Allow sign ups" />
          </Row>
          <Row
            title={
              <span className="inline-flex items-center gap-2">
                Email & password <Badge tone="outline">magic link + OTP included</Badge>
              </span>
            }
            description="Email/password sign-up, magic links and one-time codes."
          >
            <Switch checked={a.enableEmailSignup} onCheckedChange={(v) => setA({ ...a, enableEmailSignup: v })} disabled={!canEdit} label="Email" />
          </Row>
          <Row title="Confirm email" description={settings.smtp.host ? "Users must click the link in the confirmation email before signing in." : "Requires custom SMTP below — without it, emails can't be delivered."}>
            <Switch checked={!a.emailAutoconfirm} onCheckedChange={(v) => setA({ ...a, emailAutoconfirm: !v })} disabled={!canEdit || !a.enableEmailSignup} label="Confirm email" />
          </Row>
          <Row title="Phone" description="SMS one-time codes (configure an SMS provider via advanced auth settings).">
            <Switch checked={a.enablePhoneSignup} onCheckedChange={(v) => setA({ ...a, enablePhoneSignup: v })} disabled={!canEdit} label="Phone" />
          </Row>
          <Row title="Confirm phone" description="Require the SMS code before the first sign-in.">
            <Switch checked={!a.phoneAutoconfirm} onCheckedChange={(v) => setA({ ...a, phoneAutoconfirm: !v })} disabled={!canEdit || !a.enablePhoneSignup} label="Confirm phone" />
          </Row>
          <Row title="Anonymous sign-ins" description="signInAnonymously() creates a user without credentials.">
            <Switch checked={a.enableAnonymousUsers} onCheckedChange={(v) => setA({ ...a, enableAnonymousUsers: v })} disabled={!canEdit} label="Anonymous" />
          </Row>
          <Row title="JWT expiry" description="Access token lifetime in seconds (300 – 604800). Refresh tokens renew it.">
            <Input
              type="number"
              min={300}
              max={604800}
              value={a.jwtExpiry}
              onChange={(e) => setA({ ...a, jwtExpiry: Number(e.target.value) })}
              disabled={!canEdit}
              className="w-28 text-right font-mono"
              aria-label="JWT expiry"
              invalid={!!errors["auth.jwtExpiry"]}
            />
          </Row>
        </CardBody>
        <CardFooter hint={dirtyAuth ? "Unsaved changes" : "Changes restart the Auth service."}>
          <Button
            size="sm"
            variant="primary"
            disabled={!canEdit || !dirtyAuth}
            loading={busy === "methods"}
            onClick={() =>
              save("methods", {
                auth: {
                  disableSignup: a.disableSignup,
                  enableEmailSignup: a.enableEmailSignup,
                  emailAutoconfirm: a.emailAutoconfirm,
                  enablePhoneSignup: a.enablePhoneSignup,
                  phoneAutoconfirm: a.phoneAutoconfirm,
                  enableAnonymousUsers: a.enableAnonymousUsers,
                  jwtExpiry: a.jwtExpiry,
                },
              })
            }
          >
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title="OAuth providers"
          description={
            <>
              Register this callback URL with each provider: <span className="break-all font-mono text-fg">{callback}</span> <CopyButton value={callback} label="Copy callback URL" className="inline-flex align-middle" />
            </>
          }
        />
        <div className="divide-y divide-border border-t border-border">
          {OAUTH_PROVIDERS.map((p) => (
            <ProviderRow key={p.id} id={p.id} label={p.label} needsUrl={p.needsUrl} value={settings.providers[p.id]} canEdit={canEdit} busy={busy === `p:${p.id}`} save={save} errors={errors} />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="SMTP" description="Send auth emails (confirmations, magic links, password resets) through your own mail server. Without it, emails are not delivered." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Host" error={errors["smtp.host"]}>
            <Input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" disabled={!canEdit} className="font-mono" />
          </Field>
          <Field label="Port" error={errors["smtp.port"]}>
            <Input type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} disabled={!canEdit} className="font-mono" />
          </Field>
          <Field label="Username">
            <Input value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} disabled={!canEdit} autoComplete="off" />
          </Field>
          <Field label="Password" hint={settings.smtp.hasPassword ? "Saved (encrypted). Leave empty to keep it." : undefined}>
            <Input type="password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} placeholder={settings.smtp.hasPassword ? "••••••••" : ""} disabled={!canEdit} autoComplete="new-password" />
          </Field>
          <Field label="Sender email" error={errors["smtp.adminEmail"]}>
            <Input value={smtp.adminEmail} onChange={(e) => setSmtp({ ...smtp, adminEmail: e.target.value })} placeholder="no-reply@example.com" disabled={!canEdit} />
          </Field>
          <Field label="Sender name">
            <Input value={smtp.senderName} onChange={(e) => setSmtp({ ...smtp, senderName: e.target.value })} placeholder="My App" disabled={!canEdit} />
          </Field>
          {settings.smtp.host && (
            <div className="sm:col-span-2">
              <Field label="Send a test email" hint="Uses the saved settings.">
                <div className="flex gap-2">
                  <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" disabled={!canEdit} />
                  <Button
                    disabled={!canEdit || !testTo.trim()}
                    loading={busy === "smtp-test"}
                    leftIcon={<Send className="h-3.5 w-3.5" />}
                    onClick={async () => {
                      try {
                        await api(`/api/v1/base/projects/${refId}/auth/smtp-test`, { body: { to: testTo.trim() } });
                        toast.success("Test email sent", `Check ${testTo.trim()}`);
                      } catch (e) {
                        toast.error("Test failed", e instanceof ApiClientError ? e.message : undefined);
                      }
                    }}
                  >
                    Send
                  </Button>
                </div>
              </Field>
            </div>
          )}
        </CardBody>
        <CardFooter hint="The password is stored encrypted.">
          {settings.smtp.host && (
            <Button size="sm" variant="ghost" disabled={!canEdit} loading={busy === "smtp-off"} onClick={async () => (await save("smtp-off", { smtp: null }, "Custom SMTP removed")) && setSmtp({ host: "", port: 587, user: "", pass: "", adminEmail: "", senderName: "", hasPassword: false })}>
              Remove
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={!canEdit || !smtp.host.trim() || !smtp.adminEmail.trim()}
            loading={busy === "smtp"}
            onClick={async () => {
              const ok = await save("smtp", {
                smtp: { host: smtp.host.trim(), port: smtp.port, user: smtp.user, adminEmail: smtp.adminEmail.trim(), senderName: smtp.senderName, ...(smtp.pass ? { pass: smtp.pass } : {}) },
              });
              if (ok) setSmtp((s) => ({ ...s, pass: "" }));
            }}
          >
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Email templates" description="Subjects and HTML bodies of the auth emails. Leave empty to use the defaults." />
        <CardBody className="space-y-4">
          <Select value={tpl} onChange={(e) => setTpl(e.target.value)} options={EMAIL_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))} className="max-w-xs" aria-label="Template" />
          <Field label="Subject">
            <Input value={tpls[tpl]!.subject} onChange={(e) => setTpls({ ...tpls, [tpl]: { ...tpls[tpl]!, subject: e.target.value } })} disabled={!canEdit} placeholder="Confirm your signup" />
          </Field>
          <Field label="Body (HTML)" hint={<>Variables: <span className="font-mono">{EMAIL_TEMPLATES.find((t) => t.id === tpl)!.vars}</span></>}>
            <Textarea
              value={tpls[tpl]!.body}
              onChange={(e) => setTpls({ ...tpls, [tpl]: { ...tpls[tpl]!, body: e.target.value } })}
              rows={8}
              disabled={!canEdit}
              className="font-mono text-[12px]"
              placeholder={'<h2>Confirm your signup</h2>\n<p><a href="{{ .ConfirmationURL }}">Confirm your email</a></p>'}
            />
          </Field>
        </CardBody>
        <CardFooter hint={<span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> Emails are only sent when SMTP is configured.</span>}>
          <Button size="sm" variant="primary" disabled={!canEdit} loading={busy === "tpl"} onClick={() => save("tpl", { templates: { [tpl]: tpls[tpl] } }, "Template saved")}>
            Save template
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function ProviderRow({
  id,
  label,
  needsUrl,
  value,
  canEdit,
  busy,
  save,
  errors,
}: {
  id: string;
  label: string;
  needsUrl: boolean;
  value: AuthSettingsView["providers"][string] | undefined;
  canEdit: boolean;
  busy: boolean;
  save: (key: string, patch: Patch, ok?: string) => Promise<boolean>;
  errors: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(!!value?.enabled);
  const [clientId, setClientId] = useState(value?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState(value?.url ?? "");
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/50" aria-expanded={open}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-subtle text-[11px] font-semibold uppercase">{label.slice(0, 2)}</span>
        <span className="flex-1 text-[13px] font-medium">{label}</span>
        <Badge tone={value?.enabled ? "success" : "outline"}>{value?.enabled ? "Enabled" : "Disabled"}</Badge>
        <ChevronDown className={cn("h-4 w-4 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-border bg-bg-subtle px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px]">Enable {label} sign-in</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} label={`Enable ${label}`} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client ID" error={errors[`providers.${id}.clientId`]}>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!canEdit} className="font-mono" autoComplete="off" />
            </Field>
            <Field label="Client secret" hint={value?.hasSecret ? "Saved (encrypted). Leave empty to keep it." : undefined}>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={value?.hasSecret ? "••••••••" : ""} disabled={!canEdit} autoComplete="new-password" />
            </Field>
            {needsUrl && (
              <Field label={id === "azure" ? "Azure tenant URL" : "Provider URL"} className="sm:col-span-2" error={errors[`providers.${id}.url`]}>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} disabled={!canEdit} className="font-mono" placeholder={id === "azure" ? "https://login.microsoftonline.com/<tenant-id>" : "https://gitlab.example.com"} />
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2">
            {value && (
              <Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => save(`p:${id}`, { providers: { [id]: null } }, `${label} removed`)}>
                Remove
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!canEdit || (enabled && !clientId.trim()) || (enabled && !secret && !value?.hasSecret)}
              loading={busy}
              onClick={async () => {
                const ok = await save(`p:${id}`, { providers: { [id]: { enabled, clientId: clientId.trim(), ...(secret ? { secret } : {}), ...(needsUrl && url.trim() ? { url: url.trim() } : {}) } } }, `${label} saved`);
                if (ok) setSecret("");
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
