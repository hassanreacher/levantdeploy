"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Code2, KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CopyButton, Dialog, EmptyState, Field, Input, Switch, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { FUNCTION_SLUG_RE, FUNCTION_TEMPLATES, type FunctionDTO } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/components/dashboard/time-ago";

const errMsg = (e: unknown) => (e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined);

export function FunctionsList({ refId, basePath, items, canUse, running, limit }: { refId: string; basePath: string; items: FunctionDTO[]; canUse: boolean; running: boolean; limit: number | null }) {
  const [open, setOpen] = useState(false);
  const atLimit = limit !== null && items.length >= limit;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Functions</h2>
          <p className="text-[13px] text-muted">
            Server-side TypeScript on the Deno edge runtime{limit !== null ? ` · ${items.length} / ${limit} on your plan` : ""}.
          </p>
        </div>
        {canUse && (
          <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)} disabled={!running || atLimit} title={atLimit ? "Plan limit reached" : undefined}>
            New function
          </Button>
        )}
      </div>
      {items.length ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead className="bg-bg-subtle text-left text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">URL</th>
                  <th className="px-4 py-2.5 font-medium">JWT</th>
                  <th className="px-4 py-2.5 font-medium">Version</th>
                  <th className="px-4 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f.id} className="border-t border-border hover:bg-surface-2/40">
                    <td className="px-4 py-3">
                      <Link href={`${basePath}/functions/${f.slug}`} className="font-medium hover:underline">
                        {f.name}
                      </Link>
                      {f.name !== f.slug && <div className="font-mono text-[12px] text-muted">{f.slug}</div>}
                    </td>
                    <td className="max-w-[320px] px-4 py-3">
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="truncate font-mono text-[12px] text-muted">{f.url}</span>
                        <CopyButton value={f.url} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={f.verifyJwt ? "success" : "warning"}>{f.verifyJwt ? "verified" : "public"}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px]">v{f.version}</td>
                    <td className="px-4 py-3 text-muted"><TimeAgo date={f.updatedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={<Code2 className="h-5 w-5" />}
          title="No functions yet"
          description="Deploy webhooks, scheduled jobs or custom APIs next to your database. Start from a template."
          action={
            canUse ? (
              <Button variant="primary" size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)} disabled={!running}>
                Create a function
              </Button>
            ) : undefined
          }
        />
      )}
      <NewFunctionDialog open={open} onClose={() => setOpen(false)} refId={refId} basePath={basePath} />
    </section>
  );
}

function NewFunctionDialog({ open, onClose, refId, basePath }: { open: boolean; onClose: () => void; refId: string; basePath: string }) {
  const router = useRouter();
  const toast = useToast();
  const [slug, setSlug] = useState("");
  const [template, setTemplate] = useState(FUNCTION_TEMPLATES[0]!.id);
  const [verifyJwt, setVerifyJwt] = useState(true);
  const [busy, setBusy] = useState(false);
  const valid = FUNCTION_SLUG_RE.test(slug);
  const create = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/base/projects/${refId}/functions`, { body: { slug, template, verifyJwt } });
      toast.success(`Deployed ${slug}`);
      onClose();
      router.push(`${basePath}/functions/${slug}`);
      router.refresh();
    } catch (e) {
      toast.error("Could not create the function", errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="New Edge Function"
      description="It is deployed immediately; edit the code afterwards."
      size="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!valid} loading={busy} onClick={create}>
            Create & deploy
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="Lowercase letters, digits and dashes. Becomes the URL path /functions/v1/<name>." error={slug && !valid ? "Use lowercase letters, digits and dashes; start with a letter" : null}>
          <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="hello-world" className="font-mono" autoFocus />
        </Field>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-muted">Template</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {FUNCTION_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                className={cn("rounded-md border p-3 text-left transition-colors", template === t.id ? "border-fg/50 bg-surface-2" : "border-border hover:border-border-strong")}
                aria-pressed={template === t.id}
              >
                <div className="text-[13px] font-medium">{t.label}</div>
                <div className="mt-0.5 text-[12px] text-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
          <span>
            <span className="block text-[13px] font-medium">Verify JWT</span>
            <span className="block text-[12px] text-muted">Require a valid anon/user/service JWT in the Authorization header.</span>
          </span>
          <Switch checked={verifyJwt} onCheckedChange={setVerifyJwt} label="Verify JWT" />
        </label>
      </div>
    </Dialog>
  );
}

export function FunctionSecrets({ refId, initial, canEdit }: { refId: string; initial: string[]; canEdit: boolean }) {
  const toast = useToast();
  const [names, setNames] = useState(initial);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const put = async (body: { set?: Record<string, string>; remove?: string[] }, k: string, ok: string) => {
    setBusy(k);
    try {
      const r = await api<{ items: { name: string }[] }>(`/api/v1/base/projects/${refId}/secrets`, { method: "PUT", body });
      setNames(r.items.map((i) => i.name));
      toast.success(ok, "The functions runtime restarts to pick it up.");
      return true;
    } catch (e) {
      toast.error("Could not save", errMsg(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const validKey = /^[A-Z_][A-Z0-9_]*$/.test(key);
  return (
    <Card>
      <CardHeader title="Secrets" description={<>Environment variables for every function (<span className="font-mono">Deno.env.get(&quot;NAME&quot;)</span>). SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are always set.</>} />
      <CardBody className="space-y-3">
        {names.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {names.map((n) => (
              <li key={n} className="flex items-center gap-3 px-3 py-2">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="flex-1 truncate font-mono text-[13px]">{n}</span>
                <span className="font-mono text-[12px] text-subtle">••••••••</span>
                {canEdit && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${n}`} loading={busy === `rm:${n}`} onClick={() => put({ remove: [n] }, `rm:${n}`, `${n} removed`)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No secrets yet.</p>
        )}
        {canEdit && (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="STRIPE_SECRET_KEY" className="font-mono" aria-label="Secret name" invalid={!!key && !validKey} />
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" type="password" autoComplete="new-password" aria-label="Secret value" />
            <Button
              disabled={!validKey || !value}
              loading={busy === "add"}
              onClick={async () => {
                if (await put({ set: { [key]: value } }, "add", `${key} saved`)) {
                  setKey("");
                  setValue("");
                }
              }}
            >
              Add
            </Button>
          </div>
        )}
      </CardBody>
      <CardFooter hint={canEdit ? "Values are encrypted and never shown again." : "Only admins can change secrets."} />
    </Card>
  );
}
