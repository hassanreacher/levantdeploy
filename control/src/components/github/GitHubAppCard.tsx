"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Github, ExternalLink, KeyRound } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Dialog, Field, Input, Textarea, useToast, Code } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export type GitHubAppStatus =
  | { configured: false }
  | { configured: true; appId: string; slug: string; source: "settings" | "env"; htmlUrl: string | null; installUrl: string | null };

/**
 * Platform-owner card: create the LevantDeploy GitHub App with the manifest flow (one click on github.com),
 * or paste the credentials of an existing app. Shows the current app otherwise.
 */
export function GitHubAppCard({ status, isOwner, teamSlug, compact }: { status: GitHubAppStatus; isOwner: boolean; teamSlug?: string; compact?: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ action: string; manifest: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  async function startManifest() {
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      if (org.trim()) qs.set("org", org.trim());
      if (teamSlug) qs.set("team", teamSlug);
      const r = await api<{ action: string; manifest: unknown }>(`/api/v1/github/app/manifest?${qs}`);
      setForm({ action: r.action, manifest: JSON.stringify(r.manifest) });
      setTimeout(() => formRef.current?.submit(), 0);
    } catch (e) {
      toast.error("Could not start the GitHub App creation", e instanceof ApiClientError ? e.message : undefined);
      setBusy(false);
    }
  }

  if (status.configured) {
    return (
      <Card>
        <CardHeader
          title="GitHub App"
          description="Repositories are imported, deployed on push and commented on through this app."
          actions={<Badge tone="success">Connected</Badge>}
        />
        <CardBody className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Github className="h-4 w-4 text-muted" />
            <span className="font-medium text-fg">{status.slug || `App #${status.appId}`}</span>
            <span className="text-muted">· App ID</span>
            <Code>{status.appId}</Code>
            {status.source === "env" && <Badge tone="outline">from environment</Badge>}
          </div>
        </CardBody>
        <CardFooter hint="Install the app on the accounts / organizations whose repositories you want to deploy.">
          {status.htmlUrl && (
            <a href={status.htmlUrl} target="_blank" rel="noreferrer" className="text-[13px] text-muted hover:text-fg">
              App settings <ExternalLink className="inline h-3 w-3" />
            </a>
          )}
          {isOwner && status.source === "settings" && !compact && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRemoveOpen(true)}
            >
              Remove
            </Button>
          )}
        </CardFooter>
        <Dialog
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title="Remove GitHub App credentials?"
          description="Pushes and pull requests will no longer trigger deployments until an app is connected again. The app itself stays on GitHub."
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoveOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await api("/api/v1/github/app", { method: "DELETE" }).catch(() => {});
                  setBusy(false);
                  setRemoveOpen(false);
                  router.refresh();
                }}
              >
                Remove
              </Button>
            </>
          }
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Connect GitHub" description="Create a private GitHub App for this server. GitHub generates the keys and sends them back here — nothing to copy by hand." />
      <CardBody className="space-y-4">
        {!isOwner ? (
          <p className="text-sm text-muted">Ask the platform owner to create the GitHub App in Platform Settings → GitHub. You can still import any repository with “Clone from Git URL”.</p>
        ) : (
          <>
            <ul className="space-y-1.5 text-[13px] text-muted">
              <li>
                Permissions: <Code>contents:read</Code> <Code>metadata:read</Code> <Code>pull_requests:write</Code> <Code>statuses:write</Code> <Code>deployments:write</Code> <Code>checks:write</Code>
              </li>
              <li>
                Events: <Code>push</Code> <Code>pull_request</Code> <Code>delete</Code> (+ installation events) → <Code>/api/v1/webhooks/github</Code>
              </li>
              <li>The webhook URL must be reachable from github.com (public DNS + HTTPS).</li>
            </ul>
            <Field label="Organization (optional)" hint="Leave empty to create the app on your personal account." htmlFor="gh-org">
              <Input id="gh-org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="my-org" className="max-w-xs" />
            </Field>
          </>
        )}
        {form && (
          <form ref={formRef} method="post" action={form.action} className="hidden">
            <input type="hidden" name="manifest" value={form.manifest} />
          </form>
        )}
      </CardBody>
      {isOwner && (
        <CardFooter hint={<button type="button" className="hover:text-fg" onClick={() => setManualOpen(true)}>Use an existing app instead…</button>}>
          <Button variant="primary" size="sm" leftIcon={<Github className="h-4 w-4" />} loading={busy} onClick={startManifest}>
            Create GitHub App
          </Button>
        </CardFooter>
      )}
      <ManualDialog open={manualOpen} onClose={() => setManualOpen(false)} onSaved={() => router.refresh()} />
    </Card>
  );
}

function ManualDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ appId: "", slug: "", privateKey: "", webhookSecret: "", clientId: "", clientSecret: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Existing GitHub App"
      description="Credentials are verified with GitHub and stored encrypted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            leftIcon={<KeyRound className="h-4 w-4" />}
            onClick={async () => {
              setBusy(true);
              setErrors({});
              try {
                await api("/api/v1/github/app", { body: { ...v, clientId: v.clientId || null, clientSecret: v.clientSecret || null } });
                toast.success("GitHub App connected");
                onClose();
                onSaved();
              } catch (e) {
                if (e instanceof ApiClientError) {
                  setErrors(e.fields ?? {});
                  toast.error("Could not save", e.message);
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="App ID" error={errors.appId}>
          <Input value={v.appId} onChange={set("appId")} placeholder="123456" inputMode="numeric" />
        </Field>
        <Field label="App slug" error={errors.slug} hint="github.com/apps/<slug>">
          <Input value={v.slug} onChange={set("slug")} placeholder="levantdeploy-myserver" />
        </Field>
        <Field label="Webhook secret" error={errors.webhookSecret} className="sm:col-span-2">
          <Input value={v.webhookSecret} onChange={set("webhookSecret")} type="password" autoComplete="off" />
        </Field>
        <Field label="Private key (.pem)" error={errors.privateKey} className="sm:col-span-2">
          <Textarea value={v.privateKey} onChange={set("privateKey")} rows={5} className="font-mono text-xs" placeholder="-----BEGIN RSA PRIVATE KEY-----" />
        </Field>
        <Field label="Client ID (optional)" hint="Enables the ownership check on install">
          <Input value={v.clientId} onChange={set("clientId")} />
        </Field>
        <Field label="Client secret (optional)">
          <Input value={v.clientSecret} onChange={set("clientSecret")} type="password" autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}
