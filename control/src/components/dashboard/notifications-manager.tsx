"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Mail, MessageCircle, Plus, Send, Trash2, Webhook, Hash, Gamepad2, CircleAlert, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { TimeAgo } from "./time-ago";

type ChannelType = "EMAIL" | "WEBHOOK" | "TELEGRAM" | "SLACK" | "DISCORD";
export type ChannelView = {
  id: string;
  type: ChannelType;
  name: string;
  events: string[];
  enabled: boolean;
  projectId: string | null;
  project?: { id: string; name: string; slug: string } | null;
  lastSentAt: string | null;
  lastError: string | null;
  config: Record<string, string>;
};

const TYPES: { v: ChannelType; label: string; icon: React.ReactNode; hint: string }[] = [
  { v: "EMAIL", label: "Email", icon: <Mail className="h-4 w-4" />, hint: "Uses the server's SMTP settings" },
  { v: "SLACK", label: "Slack", icon: <Hash className="h-4 w-4" />, hint: "Incoming webhook URL" },
  { v: "DISCORD", label: "Discord", icon: <Gamepad2 className="h-4 w-4" />, hint: "Channel webhook URL" },
  { v: "TELEGRAM", label: "Telegram", icon: <MessageCircle className="h-4 w-4" />, hint: "Bot token + chat id" },
  { v: "WEBHOOK", label: "Webhook", icon: <Webhook className="h-4 w-4" />, hint: "Signed JSON POST (HMAC-SHA256)" },
];
const EVENTS = [
  { v: "deployment.error", label: "Deployment failed" },
  { v: "deployment.ready", label: "Deployment succeeded" },
];

const typeMeta = (t: ChannelType) => TYPES.find((x) => x.v === t)!;

function summary(c: ChannelView) {
  switch (c.type) {
    case "EMAIL":
      return c.config.to;
    case "WEBHOOK":
      return c.config.url;
    case "TELEGRAM":
      return `chat ${c.config.chatId} · bot ${c.config.botToken}`;
    default:
      return c.config.webhookUrl;
  }
}

export function NotificationsManager({
  teamSlug,
  items,
  isAdmin,
  projects,
  projectId,
}: {
  teamSlug: string;
  items: ChannelView[];
  isAdmin: boolean;
  /** team page: projects a channel can be scoped to */
  projects?: { id: string; name: string }[];
  /** project page: new channels are scoped to this project; team-wide channels are listed read-only */
  projectId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChannelView | null>(null);

  const patch = async (c: ChannelView, body: Record<string, unknown>) => {
    try {
      await api(`/api/v1/teams/${teamSlug}/notifications/${c.id}`, { method: "PATCH", body });
      router.refresh();
    } catch (e) {
      toast.error("Could not update", (e as Error).message);
    }
  };
  const test = async (c: ChannelView) => {
    setTesting(c.id);
    try {
      const r = await api<{ ok: boolean; error?: string }>(`/api/v1/teams/${teamSlug}/notifications/${c.id}/test`, { method: "POST", body: {} });
      if (r.ok) toast.success(`Test sent to ${c.name}`);
      else toast.error(`Test to ${c.name} failed`, r.error);
      router.refresh();
    } catch (e) {
      toast.error("Test failed", (e as Error).message);
    } finally {
      setTesting(null);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await api(`/api/v1/teams/${teamSlug}/notifications/${deleting.id}`, { method: "DELETE" });
      toast.success(`Removed ${deleting.name}`);
      setDeleting(null);
      router.refresh();
    } catch (e) {
      toast.error("Could not remove", (e as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Notification Channels"
        description={projectId ? "Where deployment results of this project are sent. Team-wide channels apply too." : "Get notified when deployments succeed or fail — by email, Slack, Discord, Telegram or a signed webhook."}
        actions={
          isAdmin ? (
            <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
              Add
            </Button>
          ) : undefined
        }
      />
      <div className="p-5">
        {items.length === 0 ? (
          <EmptyState icon={<BellRing className="h-5 w-5" />} title="No channels yet" description="Team members always get in-app notifications (bell). Add a channel to also notify Slack, email…" className="py-10" />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="channels">
            {items.map((c) => {
              const readOnly = !!projectId && !c.projectId;
              return (
                <li key={c.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg-subtle text-muted">{typeMeta(c.type).icon}</span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-fg">
                        {c.name}
                        <Badge tone="outline">{typeMeta(c.type).label}</Badge>
                        {c.project ? <Badge tone="neutral">{c.project.name}</Badge> : projectId ? <Badge tone="neutral">Team-wide</Badge> : null}
                        {!c.enabled && <Badge tone="warning">Paused</Badge>}
                      </p>
                      <p className="truncate font-mono text-[12px] text-muted">{summary(c)}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
                        <span>{c.events.map((e) => EVENTS.find((x) => x.v === e)?.label ?? e).join(" · ")}</span>
                        {c.lastError ? (
                          <span className="inline-flex min-w-0 items-center gap-1 text-danger" title={c.lastError}>
                            <CircleAlert className="h-3 w-3 shrink-0" /> <span className="truncate">{c.lastError}</span>
                          </span>
                        ) : c.lastSentAt ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-success" /> sent <TimeAgo date={c.lastSentAt} />
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </div>
                  {isAdmin && !readOnly && (
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      <Switch checked={c.enabled} onCheckedChange={(v) => patch(c, { enabled: v })} label={`Enable ${c.name}`} size="sm" />
                      <Button size="sm" variant="secondary" leftIcon={<Send className="h-3.5 w-3.5" />} loading={testing === c.id} onClick={() => test(c)}>
                        Test
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => setDeleting(c)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <CardFooter hint={<span className="break-all">Webhooks are signed: X-Levant-Signature: t=&lt;unix&gt;,v1=HMAC_SHA256(secret, t + &quot;.&quot; + body)</span>} />
      {open && <AddChannelDialog teamSlug={teamSlug} projects={projects} projectId={projectId} onClose={() => setOpen(false)} />}
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        size="sm"
        title="Remove channel"
        description={<>Stop sending notifications to {deleting?.name}?</>}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={remove}>
              Remove
            </Button>
          </>
        }
      />
    </Card>
  );
}

function AddChannelDialog({ teamSlug, projects, projectId, onClose }: { teamSlug: string; projects?: { id: string; name: string }[]; projectId?: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [type, setType] = useState<ChannelType>("SLACK");
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<string[]>(["deployment.error"]);
  const [scope, setScope] = useState(projectId ?? "");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const f = (k: string) => ({ value: cfg[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCfg((c) => ({ ...c, [k]: e.target.value })) });
  const genSecret = () => setCfg((c) => ({ ...c, secret: `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("")}` }));

  const submit = async () => {
    setBusy(true);
    setErrors({});
    const config =
      type === "EMAIL" ? { to: (cfg.to ?? "").split(/[,\s]+/).filter(Boolean) } : type === "WEBHOOK" ? { url: cfg.url, secret: cfg.secret } : type === "TELEGRAM" ? { botToken: cfg.botToken, chatId: cfg.chatId } : { webhookUrl: cfg.webhookUrl };
    try {
      await api(`/api/v1/teams/${teamSlug}/notifications`, { method: "POST", body: { type, name: name.trim() || typeMeta(type).label, config, events, projectId: scope || null } });
      toast.success("Channel added", "Use “Test” to send a sample message.");
      onClose();
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      setErrors(err.fields ?? {});
      toast.error("Could not add channel", err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  };
  const err = (k: string) => errors[`config.${k}`] ?? errors[k];
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Add Notification Channel"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={!events.length}>
            Add Channel
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" role="radiogroup">
          {TYPES.map((t) => (
            <button
              key={t.v}
              type="button"
              role="radio"
              aria-checked={type === t.v}
              onClick={() => (setType(t.v), setCfg({}), setErrors({}))}
              className={cn("flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-[12px] transition-colors", type === t.v ? "border-fg/50 bg-surface-2 text-fg" : "border-border text-muted hover:border-border-strong")}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <p className="-mt-2 text-[12px] text-subtle">{typeMeta(type).hint}</p>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-muted">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "SLACK" ? "#deployments" : typeMeta(type).label} maxLength={80} />
        </label>
        {type === "EMAIL" && (
          <Fld label="Recipients" error={err("to")} hint="Comma separated">
            <Input {...f("to")} placeholder="ops@example.com, me@example.com" invalid={!!err("to")} />
          </Fld>
        )}
        {(type === "SLACK" || type === "DISCORD") && (
          <Fld label="Webhook URL" error={err("webhookUrl")}>
            <Input {...f("webhookUrl")} placeholder={type === "SLACK" ? "https://hooks.slack.com/services/…" : "https://discord.com/api/webhooks/…"} className="font-mono" invalid={!!err("webhookUrl")} />
          </Fld>
        )}
        {type === "TELEGRAM" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Fld label="Bot token" error={err("botToken")} hint="From @BotFather">
              <Input {...f("botToken")} placeholder="123456:ABC-DEF…" className="font-mono" invalid={!!err("botToken")} autoComplete="off" />
            </Fld>
            <Fld label="Chat ID" error={err("chatId")} hint="User, group (-100…) or @channel">
              <Input {...f("chatId")} placeholder="-1001234567890" className="font-mono" invalid={!!err("chatId")} />
            </Fld>
          </div>
        )}
        {type === "WEBHOOK" && (
          <div className="grid gap-4">
            <Fld label="Endpoint URL" error={err("url")}>
              <Input {...f("url")} placeholder="https://example.com/hooks/levant" className="font-mono" invalid={!!err("url")} />
            </Fld>
            <Fld label="Signing secret" error={err("secret")} hint="Used to compute X-Levant-Signature. Copy it now — it is never shown again.">
              <div className="flex gap-2">
                <Input {...f("secret")} className="font-mono" invalid={!!err("secret")} autoComplete="off" />
                <Button size="md" variant="secondary" onClick={genSecret}>
                  Generate
                </Button>
              </div>
            </Fld>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-[13px] font-medium text-muted">Events</p>
            <div className="space-y-2">
              {EVENTS.map((e) => (
                <label key={e.v} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={events.includes(e.v)} onChange={() => setEvents((x) => (x.includes(e.v) ? x.filter((y) => y !== e.v) : [...x, e.v]))} />
                  {e.label}
                </label>
              ))}
            </div>
          </div>
          {projects && !projectId && (
            <label className="block">
              <span className="mb-2 block text-[13px] font-medium text-muted">Projects</span>
              <Select value={scope} onChange={(e) => setScope(e.target.value)} options={[{ value: "", label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
            </label>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Fld({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-medium text-muted">{label}</p>
      {children}
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}
