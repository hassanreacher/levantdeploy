"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Circle, Eye, EyeOff, ExternalLink, KeyRound, Loader2, ShieldAlert, X } from "lucide-react";
import { Badge, Button, Card, CodeBlock, CopyButton, Spinner, Tabs, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { BASE_SERVICES, quickstartSnippets, type BaseEventDTO, type ServiceHealth } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { BaseStatusBadge, useBaseLive } from "./common";

// ───────────────────────────── Keys ─────────────────────────────

export function KeyRow({ label, value, hint, mono = true, secret }: { label: string; value: string; hint?: React.ReactNode; mono?: boolean; secret?: boolean }) {
  return (
    <div className="grid gap-1.5 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div>
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {label}
          {secret && <Badge tone="danger">secret</Badge>}
        </div>
        {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
      </div>
      <div className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-bg-subtle pl-3">
        <span className={cn("min-w-0 flex-1 truncate py-2 text-[13px]", mono && "font-mono")}>{value}</span>
        <CopyButton value={value} label={`Copy ${label}`} className="mr-1 shrink-0" />
      </div>
    </div>
  );
}

export function ApiKeysCard({ refId, url, anonKey, canReveal }: { refId: string; url: string; anonKey: string; canReveal: boolean }) {
  const toast = useToast();
  const [service, setService] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reveal = async () => {
    if (service) return setService(null);
    setBusy(true);
    try {
      const r = await api<{ serviceRoleKey: string }>(`/api/v1/base/projects/${refId}/keys?reveal=service_role`);
      setService(r.serviceRoleKey);
    } catch (e) {
      toast.error("Could not reveal the key", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 p-5 pb-2">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <KeyRound className="h-4 w-4 text-muted" /> Project API
          </h3>
          <p className="mt-1 text-[13px] text-muted">Use the URL and the anon key in your apps with any Supabase-compatible client library.</p>
        </div>
      </div>
      <div className="divide-y divide-border px-5 pb-3">
        <KeyRow label="Project URL" value={url} hint="REST, Auth, Realtime, Storage, Functions" />
        <KeyRow label="anon public" value={anonKey || "—"} hint="Safe in browsers when Row Level Security is on" />
        <div className="grid gap-1.5 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4">
          <div>
            <div className="flex items-center gap-2 text-[13px] font-medium">
              service_role <Badge tone="danger">secret</Badge>
            </div>
            <div className="mt-0.5 text-[12px] text-muted">Bypasses RLS. Server-side only.</div>
          </div>
          <div className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-bg-subtle pl-3">
            <span className="min-w-0 flex-1 truncate py-2 font-mono text-[13px]">{service ?? "•".repeat(40)}</span>
            {service && <CopyButton value={service} label="Copy service_role key" className="shrink-0" />}
            {canReveal ? (
              <Button size="sm" variant="ghost" className="mr-1 shrink-0" loading={busy} leftIcon={service ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} onClick={reveal}>
                {service ? "Hide" : "Reveal"}
              </Button>
            ) : (
              <span className="mr-3 shrink-0 text-[12px] text-subtle">Admins only</span>
            )}
          </div>
        </div>
      </div>
      {canReveal && (
        <div className="flex items-center gap-2 rounded-b-lg border-t border-border bg-bg-subtle px-5 py-2.5 text-[12px] text-muted">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> Revealing the service_role key is recorded in the audit log.
        </div>
      )}
    </Card>
  );
}

// ───────────────────────────── Open Studio ─────────────────────────────

export function OpenStudioButton({ refId, disabled, variant = "primary", size = "sm" }: { refId: string; disabled?: boolean; variant?: "primary" | "secondary"; size?: "sm" | "md" }) {
  const toast = useToast();
  const [state, setState] = useState<"idle" | "starting">("idle");
  const open = async () => {
    // open the tab synchronously (popup blockers), navigate it once the SSO URL is ready
    const win = window.open("about:blank", "_blank");
    setState("starting");
    try {
      if (win) {
        win.document.title = "Starting Studio…";
        win.document.body.style.cssText = "font:14px system-ui;background:#0a0a0a;color:#a1a1a1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0";
        win.document.body.textContent = "Starting Studio…";
      }
      let r = await api<{ url: string; starting: boolean }>(`/api/v1/base/projects/${refId}/studio`, { method: "POST" });
      // Studio boots on demand: wait until it reports running (max ~90 s), then hand off the one-time SSO URL
      for (let i = 0; r.starting && i < 45; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const s = await api<{ state: string }>(`/api/v1/base/projects/${refId}/studio`).catch(() => ({ state: "starting" }));
        if (s.state === "running") r = await api<{ url: string; starting: boolean }>(`/api/v1/base/projects/${refId}/studio`, { method: "POST" });
      }
      if (win) win.location.href = r.url;
      else window.open(r.url, "_blank", "noopener");
    } catch (e) {
      win?.close();
      toast.error("Could not open Studio", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setState("idle");
    }
  };
  return (
    <Button variant={variant} size={size} onClick={open} disabled={disabled} loading={state === "starting"} rightIcon={state === "idle" ? <ExternalLink className="h-3.5 w-3.5" /> : undefined}>
      {state === "starting" ? "Starting Studio…" : "Open Studio"}
    </Button>
  );
}

// ───────────────────────────── Quick start ─────────────────────────────

export function QuickStart({ url, anonKey }: { url: string; anonKey: string }) {
  const snippets = useMemo(() => quickstartSnippets(url, anonKey || "<anon-key>"), [url, anonKey]);
  const [tab, setTab] = useState(snippets[0]!.id);
  const cur = snippets.find((s) => s.id === tab)!;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 p-5 pb-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Connect your app</h3>
          <p className="mt-1 text-[13px] text-muted">Same API as Supabase — use the official open-source client libraries.</p>
        </div>
        <div className="max-w-full overflow-x-auto">
          <Tabs tabs={snippets.map((s) => ({ value: s.id, label: s.label }))} value={tab} onValueChange={setTab} />
        </div>
      </div>
      <div className="px-5 pb-5">
        <CodeBlock code={cur.code} title={cur.id === "next" ? ".env.local · lib/supabase.ts" : cur.label} />
      </div>
    </Card>
  );
}

// ───────────────────────────── Health ─────────────────────────────

const STATE_STYLE: Record<string, { label: string; cls: string }> = {
  running: { label: "Healthy", cls: "bg-success" },
  starting: { label: "Starting", cls: "bg-warning animate-pulse" },
  stopped: { label: "Stopped", cls: "bg-subtle" },
  unhealthy: { label: "Unhealthy", cls: "bg-danger" },
  missing: { label: "Not running", cls: "bg-subtle" },
};

export function HealthGrid({ refId, initial }: { refId: string; initial: ServiceHealth[] }) {
  const [items, setItems] = useState(initial);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ services: ServiceHealth[] }>(`/api/v1/base/projects/${refId}/health`);
        if (alive) setItems(r.services);
      } catch {}
    };
    const t = setInterval(() => !document.hidden && tick(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refId]);
  const by = new Map(items.map((i) => [i.service, i]));
  // every core service is listed (missing containers show as "Not running"); the pooler only when present
  const shown = BASE_SERVICES.filter((s) => s.id !== "pooler" || by.has(s.id));
  return (
    <Card>
      <div className="p-5 pb-3">
        <h3 className="text-base font-semibold tracking-tight">Service health</h3>
        <p className="mt-1 text-[13px] text-muted">Containers of this project on this server. Refreshed every 15 seconds.</p>
      </div>
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-b-lg border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((s) => {
          const h = by.get(s.id) ?? { service: s.id, state: s.id === "studio" ? ("stopped" as const) : ("missing" as const) };
          const st = STATE_STYLE[h.state] ?? STATE_STYLE.missing!;
          return (
            <div key={s.id} className="flex items-center gap-3 bg-surface px-4 py-3">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", st.cls)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{s.label}</div>
                <div className="truncate text-[12px] text-muted">{h.detail || s.desc}</div>
              </div>
              <span className="shrink-0 text-[12px] text-muted">{s.id === "studio" && h.state === "stopped" ? "On demand" : st.label}</span>
            </div>
          );
        })}
        {Array.from({ length: (6 - (shown.length % 6)) % 6 }, (_, i) => (
          <div key={`f${i}`} className="hidden bg-surface sm:block" aria-hidden />
        ))}
      </div>
    </Card>
  );
}

// ───────────────────────────── Activity timeline ─────────────────────────────

const LEVEL_ICON: Record<string, React.ReactNode> = {
  success: <Check className="h-3 w-3 text-success" />,
  error: <X className="h-3 w-3 text-danger" />,
  warning: <AlertTriangle className="h-3 w-3 text-warning" />,
  info: <Circle className="h-2 w-2 fill-current text-subtle" />,
};

export function EventTimeline({ refId, initial, limit = 12 }: { refId: string; initial: BaseEventDTO[]; limit?: number }) {
  const router = useRouter();
  const live = useBaseLive(refId, { onStatus: () => router.refresh() });
  const merged = useMemo(() => {
    const m = new Map<string, BaseEventDTO>();
    for (const e of [...initial, ...live.events]) m.set(e.id, e);
    return [...m.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }, [initial, live.events, limit]);
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 p-5 pb-3">
        <h3 className="text-base font-semibold tracking-tight">Activity</h3>
        <span className={cn("inline-flex items-center gap-1.5 text-[12px]", live.connected ? "text-success" : "text-subtle")}>
          <span className={cn("h-1.5 w-1.5 rounded-full", live.connected ? "bg-success" : "bg-subtle")} /> {live.connected ? "Live" : "Offline"}
        </span>
      </div>
      {merged.length ? (
        <ol className="px-5 pb-4">
          {merged.map((e, i) => (
            <li key={e.id} className="relative flex gap-3 pb-3 last:pb-0">
              {i < merged.length - 1 && <span aria-hidden className="absolute left-[9px] top-5 h-[calc(100%-12px)] w-px bg-border" />}
              <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-bg">{LEVEL_ICON[e.level] ?? LEVEL_ICON.info}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px]">{e.message}</div>
                <div className="text-[12px] text-subtle">
                  {e.type} · <TimeAgo date={e.createdAt} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-5 pb-5 text-[13px] text-muted">No activity yet.</p>
      )}
    </Card>
  );
}

// ───────────────────────────── Provisioning ─────────────────────────────

const PROVISION_STEPS = [
  { key: "render", label: "Generating secrets & configuration", match: /secret|render|config|queued|generat/i },
  { key: "pull", label: "Pulling images", match: /pull|image/i },
  { key: "start", label: "Starting services", match: /start|creat|container|compose|up\b/i },
  { key: "migrate", label: "Initialising the database", match: /database|migrat|postgres|schema|healthy|db/i },
  { key: "route", label: "Configuring the API gateway & HTTPS", match: /route|gateway|caddy|tls|proxy/i },
] as const;

/** Full-page progress while a project is PROVISIONING (live via SSE); refreshes into the Home page once ACTIVE. */
export function ProvisioningScreen({ refId, name, url, initial, createdAt }: { refId: string; name: string; url: string; initial: BaseEventDTO[]; createdAt: string }) {
  const router = useRouter();
  const live = useBaseLive(refId, { onStatus: () => router.refresh() });
  const events = useMemo(() => {
    const m = new Map<string, BaseEventDTO>();
    for (const e of [...initial, ...live.events]) m.set(e.id, e);
    return [...m.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [initial, live.events]);
  const failed = live.status === "ERROR";
  // step index reached = last step whose pattern matched any event
  let reached = 0;
  events.forEach((e) => PROVISION_STEPS.forEach((s, i) => s.match.test(e.message) && (reached = Math.max(reached, i))));
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = now === null ? 0 : Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1000));
  return (
    <div className="mx-auto max-w-2xl">
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center gap-3 border-b border-border px-6 py-8 text-center">
          <div className={cn("flex h-12 w-12 items-center justify-center rounded-full border", failed ? "border-danger/40 bg-danger/10" : "border-border bg-bg-subtle")}>
            {failed ? <X className="h-5 w-5 text-danger" /> : <Loader2 className="h-5 w-5 animate-spin text-muted" />}
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{failed ? `${name} failed to start` : `Setting up ${name}`}</h2>
            <p className="mt-1 text-[13px] text-muted">
              {failed ? (live.message ?? "Check the activity below, then retry from Settings.") : `This usually takes 1–3 minutes · ${secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}`}
            </p>
          </div>
          <BaseStatusBadge status={live.status ?? "PROVISIONING"} />
        </div>
        <ol className="space-y-3 px-6 py-5">
          {PROVISION_STEPS.map((s, i) => {
            const state = failed && i === reached ? "failed" : i < reached ? "done" : i === reached ? "active" : "todo";
            return (
              <li key={s.key} className="flex items-center gap-3 text-[13px]">
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                    state === "done" && "border-success/40 bg-success/10",
                    state === "active" && "border-border-strong",
                    state === "failed" && "border-danger/40 bg-danger/10",
                    state === "todo" && "border-border",
                  )}
                >
                  {state === "done" ? <Check className="h-3 w-3 text-success" /> : state === "active" ? <Spinner className="h-3 w-3" /> : state === "failed" ? <X className="h-3 w-3 text-danger" /> : null}
                </span>
                <span className={cn(state === "todo" ? "text-subtle" : "text-fg")}>{s.label}</span>
              </li>
            );
          })}
        </ol>
        <div className="border-t border-border bg-bg-subtle px-6 py-3">
          <div className="mb-2 text-[12px] font-medium text-muted">Live log</div>
          <div className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed">
            {events.length ? (
              events.map((e) => (
                <div key={e.id} className={cn(e.level === "error" ? "text-danger" : e.level === "success" ? "text-success" : "text-muted")}>
                  <span className="text-subtle" suppressHydrationWarning>{new Date(e.createdAt).toLocaleTimeString()}</span> {e.message}
                </div>
              ))
            ) : (
              <div className="text-subtle">Waiting for the worker…</div>
            )}
          </div>
        </div>
      </Card>
      <p className="mt-4 text-center text-[12px] text-subtle">
        Your API will be available at <span className="font-mono">{url}</span>
      </p>
    </div>
  );
}
