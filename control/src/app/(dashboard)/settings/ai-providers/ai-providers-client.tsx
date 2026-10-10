"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Plus, RefreshCw, RotateCcw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/client/api";
import { cn, timeAgo } from "@/lib/utils";
import type { LlmHealth, LlmPurpose, LlmStatus } from "@/lib/llm/types";
import type { overview, usageStats } from "@/lib/llm/admin";
import { errText, usePlatformPatch } from "../save-helper";

type Overview = Awaited<ReturnType<typeof overview>>;
type Usage = Awaited<ReturnType<typeof usageStats>>;
type Provider = Overview["providers"][number];

const PURPOSE_HINT: Record<LlmPurpose, string> = {
  plan: "Planner: specs, file plans, data models",
  code: "Coders: file edits through tools",
  fix: "Reviewer/Fixer: type errors, lint, build failures",
  judge: "Judge: picks the best of N candidates",
  chat: "Chat replies to the user",
  vision: "Screenshots and image input",
  fast: "Small, latency-sensitive calls",
};

const STATUS: Record<LlmStatus, { label: string; dot: string; text: string; pulse?: boolean }> = {
  ok: { label: "Healthy", dot: "bg-success", text: "text-success" },
  degraded: { label: "Degraded", dot: "bg-warning", text: "text-warning" },
  down: { label: "Failing", dot: "bg-danger", text: "text-danger" },
  cooldown: { label: "Cooling down", dot: "bg-warning", text: "text-warning", pulse: true },
  unknown: { label: "No traffic yet", dot: "bg-muted", text: "text-muted" },
  disabled: { label: "Disabled", dot: "bg-border-strong", text: "text-subtle" },
  unconfigured: { label: "No key", dot: "bg-border-strong", text: "text-subtle" },
};

function Dot({ status, withLabel }: { status: LlmStatus; withLabel?: boolean }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-2" title={s.label}>
      <span className="relative inline-flex h-2.5 w-2.5">
        {s.pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", s.dot)} />}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", s.dot)} />
      </span>
      {withLabel && <span className={cn("text-[13px] font-medium", s.text)}>{s.label}</span>}
    </span>
  );
}

const fmtNum = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const fmtCtx = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`);

export function AiProvidersSettings({ initial, initialUsage }: { initial: Overview; initialUsage: Usage }) {
  const { busy, setBusy, toast, router } = usePlatformPatch();
  const [data, setData] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState<Provider | null>(null);
  useEffect(() => setData(initial), [initial]);

  // live status dots
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ providers: { id: string; status: LlmStatus; health: LlmHealth }[] }>("/api/v1/platform/ai-providers/health");
        if (!alive) return;
        setData((d) => ({ ...d, providers: d.providers.map((p) => ({ ...p, ...(r.providers.find((x) => x.id === p.id) ?? {}) })) }));
      } catch {
        /* keep last state */
      }
    };
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>, ok = "Saved") => {
      setBusy(`${id}:${Object.keys(body).join(",")}`);
      try {
        await api(`/api/v1/platform/ai-providers/${id}`, { method: "PATCH", body });
        toast.success(ok);
        router.refresh();
        return true;
      } catch (e) {
        toast.error("Could not save", errText(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [router, setBusy, toast],
  );

  const toggle = (p: Provider, enabled: boolean) => {
    if (enabled && p.warning) return setConfirmEnable(p);
    void patch(p.id, { enabled }, enabled ? `${p.label} enabled` : `${p.label} disabled`);
  };

  const active = data.providers.filter((p) => p.enabled && p.configured).length;

  return (
    <>
      <Card>
        <CardHeader
          title="AI providers"
          description="Models used by the Builder agents. Every call goes through the router: it picks the best available model per task, tracks health and rate limits, and fails over automatically."
          actions={<Badge tone={active ? "success" : "warning"}>{active ? `${active} active` : "None active"}</Badge>}
        />
        <div className="divide-y divide-border border-t border-border">
          {data.providers.map((p) => (
            <ProviderRow
              key={p.id}
              p={p}
              open={open === p.id}
              onToggleOpen={() => setOpen(open === p.id ? null : p.id)}
              onToggleEnabled={(v) => toggle(p, v)}
              patch={patch}
              busy={busy}
            />
          ))}
        </div>
        <CardFooter hint="Keys are encrypted at rest and never shown again (only the last 4 characters). Environment variables are used when no key is saved.">
          <Button variant="secondary" size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
            Add OpenAI-compatible provider
          </Button>
        </CardFooter>
      </Card>

      <PreferencesCard data={data} />
      <RoutingCard data={data} />
      <UsageCard initial={initialUsage} />

      <AddProviderDialog open={adding} onClose={() => setAdding(false)} />
      <Dialog
        open={!!confirmEnable}
        onClose={() => setConfirmEnable(null)}
        title={`Enable ${confirmEnable?.label}?`}
        description={confirmEnable?.warning}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnable(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={!!busy}
              onClick={async () => {
                if (confirmEnable && (await patch(confirmEnable.id, { enabled: true }, `${confirmEnable.label} enabled`))) setConfirmEnable(null);
              }}
            >
              I understand, enable
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">Prompts sent by the Builder include your users&apos; app descriptions and source code.</p>
      </Dialog>
    </>
  );
}

// ───────────────────────────── provider row ─────────────────────────────

function ProviderRow({
  p,
  open,
  onToggleOpen,
  onToggleEnabled,
  patch,
  busy,
}: {
  p: Provider;
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: (v: boolean) => void;
  patch: (id: string, body: Record<string, unknown>, ok?: string) => Promise<boolean>;
  busy: string | null;
}) {
  const curated = p.models.filter((m) => m.source !== "fetched");
  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <button type="button" onClick={onToggleOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
          <Dot status={p.status} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.label}</span>
              <span className="font-mono text-[12px] text-subtle">{p.id}</span>
              {p.warning && (
                <Badge tone="danger" icon={<AlertTriangle className="h-3 w-3" />}>
                  Logs prompts
                </Badge>
              )}
              {p.custom && <Badge tone="outline">Custom</Badge>}
              {p.rotate && <Badge tone="outline">Rotates models</Badge>}
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-muted">
              {STATUS[p.status].label}
              {p.keyHint ? ` · key ${p.keyHint} (${p.keySource === "env" ? "env" : "saved"})` : ""}
              {p.health.latencyMs !== null ? ` · ${p.health.latencyMs} ms` : ""}
              {p.health.success + p.health.failure > 0 ? ` · ${Math.round(p.health.successRate * 100)}% ok` : ""}
              {` · ${curated.length} models`}
            </span>
          </span>
        </button>
        <Switch checked={p.enabled} onCheckedChange={onToggleEnabled} label={`Enable ${p.label}`} disabled={busy?.startsWith(`${p.id}:enabled`)} />
      </div>
      {open && <ProviderDetail p={p} patch={patch} busy={busy} />}
    </div>
  );
}

function ProviderDetail({ p, patch, busy }: { p: Provider; patch: (id: string, body: Record<string, unknown>, ok?: string) => Promise<boolean>; busy: string | null }) {
  const { toast, router } = usePlatformPatch();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.baseUrl === p.defaultBaseUrl ? "" : p.baseUrl);
  const [vars, setVars] = useState<Record<string, string>>(p.vars);
  const [headers, setHeaders] = useState(
    Object.entries(p.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  const [limits, setLimits] = useState({ rpm: p.limits.rpm ?? "", rpd: p.limits.rpd ?? "", modelRpm: p.limits.modelRpm ?? "", modelRpd: p.limits.modelRpd ?? "" });
  const [testModel, setTestModel] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; model: string | null; latencyMs: number; text?: string; error?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showFetched, setShowFetched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const curated = p.models.filter((m) => m.source !== "fetched");
  const fetched = p.models.filter((m) => m.source === "fetched");

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api(`/api/v1/platform/ai-providers/${p.id}/test`, { body: testModel ? { model: testModel } : {} }));
      router.refresh();
    } catch (e) {
      toast.error("Test failed", errText(e));
    } finally {
      setTesting(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api<{ count: number }>(`/api/v1/platform/ai-providers/${p.id}/models`, { body: {} });
      toast.success(`Fetched ${r.count} models`);
      router.refresh();
    } catch (e) {
      toast.error("Could not fetch models", errText(e));
    } finally {
      setRefreshing(false);
    }
  };
  const parseHeaders = () =>
    Object.fromEntries(
      headers
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
        .filter(([k]) => k),
    );
  const num = (v: string | number) => (v === "" ? undefined : Number(v));
  const toggleModel = (id: string, disabled: boolean) => patch(p.id, { modelOverrides: { [id]: { disabled } } }, disabled ? `${id} disabled` : `${id} enabled`);

  return (
    <div className="space-y-5 border-t border-border bg-bg-subtle px-4 py-5 sm:px-6">
      {p.warning && (
        <div className="flex gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {p.warning}
        </div>
      )}
      {p.notes && <p className="text-[13px] text-muted">{p.notes}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="API key" htmlFor={`key-${p.id}`} hint={p.keyHint ? `Current: ${p.keyHint} (${p.keySource === "env" ? "from environment" : "saved"})` : "No key yet"}>
          <div className="flex gap-2">
            <Input id={`key-${p.id}`} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keyHint || "Paste a key"} className="font-mono" />
            <Button
              variant="secondary"
              disabled={!key}
              loading={busy === `${p.id}:apiKey`}
              onClick={async () => {
                if (await patch(p.id, { apiKey: key }, "Key saved")) setKey("");
              }}
            >
              Save
            </Button>
          </div>
          {p.keySource === "setting" && (
            <button type="button" className="mt-1 text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => patch(p.id, { apiKey: "" }, "Saved key removed")}>
              Remove saved key
            </button>
          )}
        </Field>
        <Field label="Test" htmlFor={`test-${p.id}`} hint="Sends a tiny request and shows latency.">
          <div className="flex gap-2">
            <Select
              id={`test-${p.id}`}
              value={testModel}
              onChange={(e) => setTestModel(e.target.value)}
              options={[{ value: "", label: "Default model" }, ...curated.map((m) => ({ value: m.id, label: m.id }))]}
            />
            <Button variant="secondary" leftIcon={<Zap className="h-3.5 w-3.5" />} loading={testing} onClick={test} disabled={!p.configured}>
              Test
            </Button>
          </div>
          {result && (
            <p className={cn("mt-1.5 break-words font-mono text-[12px]", result.ok ? "text-success" : "text-danger")}>
              {result.ok ? `OK · ${result.model} · ${result.latencyMs} ms${result.text ? ` · “${result.text.trim().slice(0, 30)}”` : ""}` : `${result.error ?? "Failed"}`}
            </p>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Base URL" htmlFor={`url-${p.id}`} hint={p.custom ? undefined : `Default: ${p.defaultBaseUrl}`}>
          <Input id={`url-${p.id}`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={p.defaultBaseUrl} className="font-mono text-[12px]" />
        </Field>
        <Field label="Extra headers" htmlFor={`h-${p.id}`} hint="One per line, e.g. HTTP-Referer: https://example.com">
          <Textarea id={`h-${p.id}`} rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} className="font-mono text-[12px]" />
        </Field>
        {p.extraVars.map((v) => (
          <Field key={v} label={v} htmlFor={`v-${p.id}-${v}`} hint="Used in the base URL">
            <Input id={`v-${p.id}-${v}`} value={vars[v] ?? ""} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} className="font-mono" />
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(
          [
            ["rpm", "Requests / min"],
            ["rpd", "Requests / day"],
            ["modelRpm", "Per model / min"],
            ["modelRpd", "Per model / day"],
          ] as const
        ).map(([k, label]) => (
          <Field key={k} label={label} htmlFor={`l-${p.id}-${k}`}>
            <Input id={`l-${p.id}-${k}`} type="number" min={1} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} placeholder="∞" />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={busy?.startsWith(`${p.id}:baseUrl`)}
          onClick={() =>
            patch(p.id, {
              baseUrl: baseUrl.trim() || null,
              headers: parseHeaders(),
              vars,
              limits: { rpm: num(limits.rpm), rpd: num(limits.rpd), modelRpm: num(limits.modelRpm), modelRpd: num(limits.modelRpd) },
            })
          }
        >
          Save connection settings
        </Button>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[13px] font-medium">Models</h4>
          <div className="flex items-center gap-2">
            {p.modelsFetchedAt && <span className="text-[12px] text-subtle">fetched {timeAgo(p.modelsFetchedAt)}</span>}
            {p.modelsEndpoint && p.kind === "openai" && (
              <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} loading={refreshing} onClick={refresh} disabled={!p.configured}>
                Fetch /models
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Capabilities</th>
                <th className="px-3 py-2 font-medium">Context</th>
                <th className="px-3 py-2 text-right font-medium">Use</th>
              </tr>
            </thead>
            <tbody>
              {curated.map((m) => {
                const disabled = !!(m as { disabled?: boolean }).disabled;
                return (
                  <tr key={m.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-[12px]">{m.id}</td>
                    <td className="px-3 py-2">
                      <Badge tone={m.tier === "smart" ? "accent" : "neutral"}>{m.tier}</Badge>
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted">{[m.tools ? "tools" : "text-tools", m.vision ? "vision" : null, m.free ? "free" : null].filter(Boolean).join(" · ")}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">
                      {fmtCtx(m.contextWindow)} / {fmtCtx(m.maxOutput)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Switch size="sm" checked={!disabled} onCheckedChange={(v) => toggleModel(m.id, !v)} label={`Use ${m.id}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {fetched.length > 0 && (
          <div className="mt-2">
            <button type="button" className="text-[12px] text-muted hover:text-fg" onClick={() => setShowFetched(!showFetched)}>
              {showFetched ? "Hide" : "Show"} {fetched.length} more models from /models (usable via Model preferences)
            </button>
            {showFetched && <p className="mt-1 max-h-40 overflow-auto break-words font-mono text-[11px] leading-5 text-subtle">{fetched.map((m) => m.id).join("  ·  ")}</p>}
          </div>
        )}
      </div>

      {p.health.lastErrors.length > 0 && (
        <div>
          <h4 className="mb-1 text-[13px] font-medium">Recent errors</h4>
          <ul className="space-y-1 text-[12px]">
            {p.health.lastErrors.map((e, i) => (
              <li key={i} className="break-words text-muted">
                <span className="font-mono text-danger">{e.code}</span> {timeAgo(e.at)} · {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <span className="text-[12px] text-muted">
          {p.health.cooldownUntil ? `Cooling down until ${new Date(p.health.cooldownUntil).toLocaleTimeString()} — ${p.health.cooldownReason}` : p.docsUrl ? <a className="hover:text-fg hover:underline" href={p.docsUrl} target="_blank" rel="noreferrer">Provider docs ↗</a> : null}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={async () => {
              await api("/api/v1/platform/ai-providers/health/reset", { body: { scope: p.id } });
              toast.success("Health and cooldowns cleared");
              router.refresh();
            }}
          >
            Reset health
          </Button>
          <Button variant={p.custom ? "danger" : "ghost"} size="sm" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDelete(true)}>
            {p.custom ? "Delete provider" : "Reset to defaults"}
          </Button>
        </div>
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={p.custom ? `Delete ${p.label}?` : `Reset ${p.label}?`}
        description={p.custom ? "The provider, its key and its models are removed." : "The saved key, base URL, headers, models and limits are removed; environment keys still apply."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api(`/api/v1/platform/ai-providers/${p.id}`, { method: "DELETE" });
                  toast.success(p.custom ? "Provider deleted" : "Provider reset");
                  setConfirmDelete(false);
                  router.refresh();
                } catch (e) {
                  toast.error("Failed", errText(e));
                }
              }}
            >
              {p.custom ? "Delete" : "Reset"}
            </Button>
          </>
        }
      />
    </div>
  );
}

// ───────────────────────────── add custom provider ─────────────────────────────

function AddProviderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, router } = usePlatformPatch();
  const [f, setF] = useState({ id: "", label: "", baseUrl: "", apiKey: "", models: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const submit = async () => {
    setBusy(true);
    setErr({});
    try {
      const models = f.models
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => ({ id }));
      await api("/api/v1/platform/ai-providers", { body: { id: f.id, label: f.label || f.id, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, models } });
      toast.success("Provider added");
      setF({ id: "", label: "", baseUrl: "", apiKey: "", models: "" });
      onClose();
      router.refresh();
    } catch (e) {
      const ae = e as { fields?: Record<string, string> };
      if (ae.fields) setErr(ae.fields);
      toast.error("Could not add provider", errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add OpenAI-compatible provider"
      description="Any endpoint that implements POST /chat/completions (vLLM, LiteLLM, LocalAI, another gateway …)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!f.id || !f.baseUrl}>
            Add provider
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ID" htmlFor="np-id" error={err.id}>
            <Input id="np-id" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="my-vllm" className="font-mono" />
          </Field>
          <Field label="Name" htmlFor="np-label" error={err.label}>
            <Input id="np-label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="My vLLM" />
          </Field>
        </div>
        <Field label="Base URL" htmlFor="np-url" error={err.baseUrl} hint="Up to /v1 — /chat/completions is appended.">
          <Input id="np-url" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://llm.example.com/v1" className="font-mono" />
        </Field>
        <Field label="API key" htmlFor="np-key">
          <Input id="np-key" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Models" htmlFor="np-models" hint="Comma or newline separated. You can also fetch /models after adding.">
          <Textarea id="np-models" rows={2} value={f.models} onChange={(e) => setF({ ...f, models: e.target.value })} className="font-mono text-[12px]" placeholder="qwen3-coder-30b, llama-3.3-70b" />
        </Field>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── preferences (drag to reorder) ─────────────────────────────

function PreferencesCard({ data }: { data: Overview }) {
  const { toast, router } = usePlatformPatch();
  const [purpose, setPurpose] = useState<LlmPurpose>("code");
  const [lists, setLists] = useState(data.preferences);
  const [dirty, setDirty] = useState<Set<LlmPurpose>>(new Set());
  const [drag, setDrag] = useState<number | null>(null);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setLists(data.preferences);
    setDirty(new Set());
  }, [data.preferences]);

  const byRef = useMemo(() => {
    const m = new Map<string, { provider: Provider; model: Provider["models"][number] }>();
    for (const p of data.providers) for (const model of p.models) m.set(`${p.id}/${model.id}`, { provider: p, model });
    return m;
  }, [data.providers]);
  const list = lists[purpose] ?? [];
  const set = (next: string[]) => {
    setLists({ ...lists, [purpose]: next });
    setDirty(new Set(dirty).add(purpose));
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    set(next);
  };
  const options = [...byRef.entries()]
    .filter(([ref, v]) => !list.includes(ref) && v.provider.configured && !(v.model as { disabled?: boolean }).disabled)
    .map(([ref, v]) => ({ value: ref, label: `${v.provider.label} · ${v.model.id}${v.model.source === "fetched" ? " (fetched)" : ""}` }));

  const save = async (reset = false) => {
    setSaving(true);
    try {
      await api("/api/v1/platform/ai-providers/preferences", {
        method: "PUT",
        body: reset ? { reset: [purpose] } : { preferences: Object.fromEntries([...dirty].map((p) => [p, lists[p]])) },
      });
      toast.success(reset ? "Restored the default order" : "Preferences saved");
      setDirty(new Set());
      router.refresh();
    } catch (e) {
      toast.error("Could not save", errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Model preferences" description="Ranked models per task. The router tries them top to bottom, skipping disabled, unconfigured, cooling-down or rate-limited ones, then any other enabled model that fits." />
      <CardBody className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1">
          <Tabs<LlmPurpose> value={purpose} onValueChange={setPurpose} tabs={data.purposes.map((p) => ({ value: p, label: dirty.has(p) ? `${p} •` : p }))} />
        </div>
        <p className="text-[13px] text-muted">
          {PURPOSE_HINT[purpose]}
          {data.customPreferences.includes(purpose) ? "" : " · using the built-in order"}
        </p>
        {list.length === 0 ? (
          <EmptyState title="No preferred models" description="The router will use any enabled model that fits." />
        ) : (
          <ol className="divide-y divide-border rounded-md border border-border">
            {list.map((ref, i) => {
              const info = byRef.get(ref);
              const usable = info && info.provider.enabled && info.provider.configured && !(info.model as { disabled?: boolean }).disabled;
              return (
                <li
                  key={ref}
                  draggable
                  onDragStart={() => setDrag(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (drag !== null) move(drag, i);
                    setDrag(null);
                  }}
                  className={cn("flex items-center gap-2 bg-surface px-2 py-2 text-[13px]", drag === i && "opacity-50")}
                >
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-subtle" aria-hidden />
                  <span className="w-5 shrink-0 text-right font-mono text-[12px] text-subtle">{i + 1}</span>
                  {info ? <Dot status={info.provider.status} /> : <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />}
                  <span className={cn("min-w-0 flex-1 truncate font-mono text-[12px]", !usable && "text-subtle line-through")}>{ref}</span>
                  {info && <Badge tone={info.model.tier === "smart" ? "accent" : "neutral"}>{info.model.tier}</Badge>}
                  {!usable && <span className="hidden text-[12px] text-subtle sm:inline">{!info ? "unknown" : !info.provider.configured ? "no key" : "off"}</span>}
                  <Button variant="ghost" size="icon" aria-label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Move down" onClick={() => move(i, i + 1)} disabled={i === list.length - 1}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => set(list.filter((x) => x !== ref))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex gap-2">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} options={[{ value: "", label: "Add a model…" }, ...options]} />
          <Button
            variant="secondary"
            disabled={!adding}
            onClick={() => {
              set([...list, adding]);
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      </CardBody>
      <CardFooter hint={dirty.size ? `Unsaved changes: ${[...dirty].join(", ")}` : "Drag rows or use the arrows to reorder."}>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => save(true)} disabled={saving || !data.customPreferences.includes(purpose)}>
            Restore default
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty.size} onClick={() => save()}>
            Save
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

// ───────────────────────────── routing ─────────────────────────────

function RoutingCard({ data }: { data: Overview }) {
  const { toast, router } = usePlatformPatch();
  const [r, setR] = useState({ timeoutSec: String(Math.round(data.routing.timeoutMs / 1000)), maxAttempts: String(data.routing.maxAttempts), sameModelRetries: String(data.routing.sameModelRetries) });
  const [saving, setSaving] = useState(false);
  return (
    <Card>
      <CardHeader title="Resilience" description="How long to wait for a provider and how many models to try before a step fails." />
      <CardBody className="grid gap-4 sm:grid-cols-3">
        <Field label="Timeout (seconds)" htmlFor="rt-timeout" hint="No first byte / no new chunk for this long → next model">
          <Input id="rt-timeout" type="number" min={5} max={600} value={r.timeoutSec} onChange={(e) => setR({ ...r, timeoutSec: e.target.value })} />
        </Field>
        <Field label="Max attempts" htmlFor="rt-max" hint="Models tried per request">
          <Input id="rt-max" type="number" min={1} max={20} value={r.maxAttempts} onChange={(e) => setR({ ...r, maxAttempts: e.target.value })} />
        </Field>
        <Field label="Same-model retries" htmlFor="rt-same" hint="For transient 5xx / network errors">
          <Input id="rt-same" type="number" min={0} max={3} value={r.sameModelRetries} onChange={(e) => setR({ ...r, sameModelRetries: e.target.value })} />
        </Field>
      </CardBody>
      <CardFooter hint="429, quota and “high demand” errors put the model in a cool-down (Retry-After honoured).">
        <Button
          variant="secondary"
          size="sm"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api("/api/v1/platform/ai-providers/preferences", {
                method: "PUT",
                body: { routing: { timeoutMs: Number(r.timeoutSec) * 1000, maxAttempts: Number(r.maxAttempts), sameModelRetries: Number(r.sameModelRetries) } },
              });
              toast.success("Saved");
              router.refresh();
            } catch (e) {
              toast.error("Could not save", errText(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}

// ───────────────────────────── usage ─────────────────────────────

function UsageCard({ initial }: { initial: Usage }) {
  const [range, setRange] = useState<Usage["range"]>(initial.range);
  const [u, setU] = useState(initial);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (range === u.range) return;
    setLoading(true);
    api<Usage>(`/api/v1/platform/ai-providers/usage?range=${range}`)
      .then(setU)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [range, u.range]);
  return (
    <Card>
      <CardHeader
        title="Usage"
        description={`${fmtNum(u.totals.requests)} requests · ${fmtNum(u.totals.errors)} errors · ${fmtNum(u.totals.inputTokens)} in / ${fmtNum(u.totals.outputTokens)} out tokens`}
        actions={
          <Tabs<Usage["range"]>
            value={range}
            onValueChange={setRange}
            tabs={[
              { value: "24h", label: "24h" },
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
          />
        }
      />
      {u.rows.length === 0 ? (
        <CardBody>
          <EmptyState title="No LLM calls yet" description="Usage appears here once the Builder (or a Test button) calls a provider." />
        </CardBody>
      ) : (
        <div className={cn("overflow-x-auto border-t border-border", loading && "opacity-60")}>
          <Table>
            <THead>
              <TR>
                <TH>Provider / model</TH>
                <TH className="text-right">Requests</TH>
                <TH className="text-right">Errors</TH>
                <TH className="text-right">Tokens in / out</TH>
                <TH className="text-right">Avg latency</TH>
              </TR>
            </THead>
            <TBody>
              {u.rows.map((r) => (
                <TR key={`${r.provider}/${r.model}`}>
                  <TD className="font-mono text-[12px]">
                    {r.provider}/<span className="text-muted">{r.model}</span>
                  </TD>
                  <TD className="text-right tabular-nums">{fmtNum(r.requests)}</TD>
                  <TD className={cn("text-right tabular-nums", r.errors > 0 && "text-danger")}>{fmtNum(r.errors)}</TD>
                  <TD className="text-right tabular-nums text-muted">
                    {fmtNum(r.inputTokens)} / {fmtNum(r.outputTokens)}
                  </TD>
                  <TD className="text-right tabular-nums text-muted">{r.avgLatencyMs} ms</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      {u.errors.length > 0 && (
        <CardBody className="border-t border-border">
          <h4 className="mb-2 text-[13px] font-medium">Recent errors</h4>
          <ul className="space-y-1.5 text-[12px]">
            {u.errors.slice(0, 8).map((e) => (
              <li key={e.id} className="break-words text-muted">
                <span className="font-mono text-danger">{e.errorCode}</span> <span className="font-mono">{e.provider}/{e.model}</span> · {e.purpose} · {timeAgo(e.createdAt)}
                {e.error ? ` — ${e.error}` : ""}
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}
