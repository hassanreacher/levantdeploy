"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { api, ApiClientError } from "@/lib/client/api";
import type { LimitField, PlanLimits } from "@/lib/plans/limits";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { fmtLimit, fmtValue, type UsageUnit } from "@/components/plans/format";
import { cn } from "@/lib/utils";

type PlanRow = {
  id: string | null;
  slug: string;
  name: string;
  description: string | null;
  priceMonthly: number | null;
  isDefault: boolean;
  isInternal: boolean;
  sortOrder: number;
  archivedAt: string | Date | null;
  teams: number;
  limits: PlanLimits;
};
type TeamRow = {
  id: string;
  slug: string;
  name: string;
  isPersonal: boolean;
  plan: { id: string | null; slug: string; name: string };
  source: "assigned" | "owner" | "default";
  counts: { projects: number; memberships: number; baseProjects: number };
  overQuota: { resource: string; label: string; used: number; limit: number | null; unit: UsageUnit; scope: { name: string } | null; enforced: boolean }[];
  nearQuota: number;
};
type RequestRow = { id: string; team: { slug: string; name: string }; plan: { id: string; name: string } | null; message: string | null; by: string | null; createdAt: string };

const get = (l: PlanLimits, key: string) => {
  const [g, k] = key.split(".") as ["deploy" | "base" | "builder", string];
  return ((l[g] ?? {}) as Record<string, unknown>)[k];
};

/** Form state: numbers as strings ("" = unlimited) so the inputs stay controlled. */
type Draft = { slug: string; name: string; description: string; price: string; isDefault: boolean; isInternal: boolean; values: Record<string, string | boolean>; enforce: Record<string, boolean> };

function toDraft(p: PlanRow, fields: LimitField[]): Draft {
  const values: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = get(p.limits, f.key);
    values[f.key] = f.type === "boolean" ? !!v : v === null || v === undefined ? "" : String(v);
  }
  return {
    slug: p.slug,
    name: p.name,
    description: p.description ?? "",
    price: p.priceMonthly === null ? "" : String(p.priceMonthly),
    isDefault: p.isDefault,
    isInternal: p.isInternal,
    values,
    enforce: Object.fromEntries(fields.filter((f) => f.resource).map((f) => [f.resource!, p.limits.enforce[f.resource!] !== false])),
  };
}

function fromDraft(d: Draft, fields: LimitField[]): { body: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const limits: { deploy: Record<string, unknown>; base: Record<string, unknown>; builder: Record<string, unknown>; enforce: Record<string, boolean> } = { deploy: {}, base: {}, builder: {}, enforce: d.enforce };
  for (const f of fields) {
    const [g, k] = f.key.split(".") as ["deploy" | "base" | "builder", string];
    const raw = d.values[f.key];
    if (f.type === "boolean") {
      limits[g][k] = !!raw;
      continue;
    }
    const s = String(raw ?? "").trim();
    if (s === "") {
      if (!f.nullable) errors[f.key] = "Required";
      limits[g][k] = null;
      continue;
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) errors[f.key] = "Enter a number ≥ 0";
    else if (f.type === "integer" && !Number.isInteger(n)) errors[f.key] = "Whole number";
    limits[g][k] = n;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(d.slug)) errors.slug = "Lowercase letters, digits and dashes";
  if (!d.name.trim()) errors.name = "Required";
  const price = d.price.trim() === "" ? null : Number(d.price);
  if (price !== null && (!Number.isInteger(price) || price < 0)) errors.price = "Whole number ≥ 0";
  return {
    body: { slug: d.slug, name: d.name.trim(), description: d.description.trim() || null, priceMonthly: price, isDefault: d.isDefault || undefined, isInternal: d.isInternal, limits },
    errors,
  };
}

function PlanEditor({ plan, fields, onDone }: { plan: PlanRow; fields: LimitField[]; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => toDraft(plan, fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const isNew = !plan.id;
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setVal = (k: string, v: string | boolean) => setD((x) => ({ ...x, values: { ...x.values, [k]: v } }));

  const save = async () => {
    const { body, errors: errs } = fromDraft(d, fields);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy("save");
    try {
      if (isNew) await api("/api/v1/platform/plans", { body });
      else await api(`/api/v1/platform/plans/${plan.id}`, { method: "PATCH", body });
      toast.success(isNew ? "Plan created" : "Plan saved");
      router.refresh();
      onDone();
    } catch (e) {
      if (e instanceof ApiClientError && e.fields) setErrors(e.fields);
      toast.error("Could not save the plan", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  const action = async (kind: "archive" | "unarchive" | "delete") => {
    setBusy(kind);
    try {
      if (kind === "delete") await api(`/api/v1/platform/plans/${plan.id}`, { method: "DELETE" });
      else await api(`/api/v1/platform/plans/${plan.id}`, { method: "PATCH", body: { archived: kind === "archive" } });
      toast.success(kind === "delete" ? "Plan deleted" : kind === "archive" ? "Plan archived" : "Plan restored");
      router.refresh();
      onDone();
    } catch (e) {
      toast.error("Action failed", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const group = (g: "deploy" | "base" | "builder", title: string) => (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</legend>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {fields
          .filter((f) => f.group === g)
          .map((f) => (
            <div key={f.key} className="min-w-0">
              {f.type === "boolean" ? (
                <div className="flex h-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <span className="text-[13px]">{f.label}</span>
                  <Switch checked={!!d.values[f.key]} onCheckedChange={(v) => setVal(f.key, v)} label={f.label} />
                </div>
              ) : (
                <Field label={f.label} htmlFor={`f-${f.key}`} error={errors[f.key]} hint={f.hint ?? (f.nullable ? "Empty = unlimited" : undefined)}>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`f-${f.key}`}
                      inputMode="decimal"
                      placeholder={f.nullable ? "Unlimited" : ""}
                      value={String(d.values[f.key] ?? "")}
                      onChange={(e) => setVal(f.key, e.target.value)}
                      suffix={f.unit}
                      invalid={!!errors[f.key]}
                    />
                    {f.resource && (
                      <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted" title="Enforce: block at 100 %. Off = warn only.">
                        <Switch size="sm" checked={d.enforce[f.resource] !== false} onCheckedChange={(v) => setD((x) => ({ ...x, enforce: { ...x.enforce, [f.resource!]: v } }))} label={`Enforce ${f.label}`} />
                        Enforce
                      </label>
                    )}
                  </div>
                </Field>
              )}
            </div>
          ))}
      </div>
    </fieldset>
  );

  return (
    <Card>
      <CardHeader title={isNew ? "New plan" : `Edit ${plan.name}`} description="Limits are validated against the PlanLimits JSON schema. “Enforce” off = warn at 80 % / 100 % but never block." />
      <CardBody className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" htmlFor="p-name" error={errors.name}>
            <Input id="p-name" value={d.name} onChange={(e) => set({ name: e.target.value })} invalid={!!errors.name} />
          </Field>
          <Field label="Slug" htmlFor="p-slug" error={errors.slug}>
            <Input id="p-slug" value={d.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} className="font-mono" invalid={!!errors.slug} />
          </Field>
          <Field label="Price / month" htmlFor="p-price" error={errors.price} hint="Display only — no billing">
            <Input id="p-price" inputMode="numeric" value={d.price} onChange={(e) => set({ price: e.target.value })} prefix="$" placeholder="—" />
          </Field>
        </div>
        <Field label="Description" htmlFor="p-desc">
          <Textarea id="p-desc" rows={2} value={d.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-6 text-[13px]">
          <label className="flex items-center gap-2">
            <Switch checked={d.isDefault} disabled={plan.isDefault} onCheckedChange={(v) => set({ isDefault: v })} label="Default plan" />
            Default for new teams
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={d.isInternal} onCheckedChange={(v) => set({ isInternal: v })} label="Internal" />
            Internal (hidden from upgrade options)
          </label>
        </div>
        {group("deploy", "Deploy")}
        {group("base", "Backends")}
        {group("builder", "AI app builder")}
      </CardBody>
      <CardFooter
        hint={
          !isNew && (
            <div className="flex flex-wrap gap-2">
              {plan.archivedAt ? (
                <Button size="sm" variant="ghost" loading={busy === "unarchive"} onClick={() => action("unarchive")}>
                  Restore
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={plan.isDefault} loading={busy === "archive"} onClick={() => action("archive")}>
                  Archive
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-danger" disabled={plan.isDefault || plan.teams > 0} loading={busy === "delete"} onClick={() => action("delete")}>
                Delete
              </Button>
            </div>
          )
        }
      >
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={busy === "save"} onClick={save} data-testid="plan-save">
            {isNew ? "Create plan" : "Save"}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

export function PlansAdmin({ plans, fields, teams, requests }: { plans: PlanRow[]; fields: LimitField[]; teams: TeamRow[]; requests: RequestRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [overOnly, setOverOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const active = plans.filter((p) => !p.archivedAt);
  const planOptions = useMemo(() => [{ value: "", label: "Automatic" }, ...active.map((p) => ({ value: p.id!, label: p.name }))], [active]);
  const shownTeams = overOnly ? teams.filter((t) => t.overQuota.length) : teams;
  const overCount = teams.filter((t) => t.overQuota.length).length;

  const assign = async (team: string, plan: string | null, key = team) => {
    setBusy(key);
    try {
      await api("/api/v1/platform/plans/assign", { body: { team, plan } });
      toast.success("Plan assigned");
      router.refresh();
    } catch (e) {
      toast.error("Could not assign the plan", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/v1/platform/plans/requests/${id}`, { method: "PATCH", body: { status: "DISMISSED" } });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };
  const newPlan = () => {
    const base = plans.find((p) => p.slug === "pro") ?? plans[0]!;
    setEditing({ ...base, id: null, slug: "custom", name: "Custom", description: null, isDefault: false, isInternal: false, archivedAt: null, teams: 0 });
  };

  if (editing) return <PlanEditor plan={editing} fields={fields} onDone={() => setEditing(null)} />;

  return (
    <>
      {requests.length > 0 && (
        <Card>
          <CardHeader title="Upgrade requests" description="Teams asking for a bigger plan. There are no payments yet — assign the plan here." />
          <ul className="divide-y divide-border">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 px-5 py-3 text-[13px] sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p>
                    <span className="font-medium">{r.team.name}</span> <span className="text-muted">/{r.team.slug}</span> wants <span className="font-medium">{r.plan?.name ?? "an upgrade"}</span>
                  </p>
                  <p className="text-muted">
                    {r.by ? `${r.by} · ` : ""}
                    {new Date(r.createdAt).toLocaleString()}
                    {r.message ? ` · “${r.message}”` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                {r.plan && (
                  <Button size="sm" variant="primary" loading={busy === `req:${r.id}`} onClick={() => assign(r.team.slug, r.plan!.id, `req:${r.id}`)}>
                    Assign {r.plan.name}
                  </Button>
                )}
                <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => dismiss(r.id)}>
                  Dismiss
                </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Plans"
          description="Limits for Deploy projects and Backends. Teams without an assigned plan get the default plan; your own teams are unlimited."
          actions={
            <Button size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={newPlan}>
              New plan
            </Button>
          }
        />
        <ul className="divide-y divide-border">
          {plans.map((p) => (
            <li key={p.slug} className={cn("flex flex-wrap items-center gap-3 px-5 py-3", p.archivedAt && "opacity-60")} data-plan={p.slug}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="font-mono text-[12px] text-subtle">{p.slug}</span>
                  {p.isDefault && <Badge tone="accent">Default</Badge>}
                  {p.isInternal && <Badge tone="outline">Internal</Badge>}
                  {p.archivedAt && <Badge>Archived</Badge>}
                </div>
                <p className="mt-0.5 text-[12px] text-muted">
                  {p.priceMonthly ? `$${p.priceMonthly}/mo` : p.priceMonthly === 0 ? "Free" : "—"} · {fmtLimit(p.limits.deploy.projects, "count")} projects · {fmtLimit(p.limits.deploy.deploymentsPerDay, "count")} deploys/day ·{" "}
                  {fmtLimit(p.limits.base.projects, "count")} backends · {p.teams} team{p.teams === 1 ? "" : "s"} assigned
                </p>
              </div>
              <Button size="sm" onClick={() => setEditing(p)} data-testid={`edit-${p.slug}`}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Teams"
          description={overCount ? `${overCount} team${overCount === 1 ? " is" : "s are"} over quota.` : "No team is over quota."}
          actions={
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <Switch size="sm" checked={overOnly} onCheckedChange={setOverOnly} label="Over quota only" />
              Over quota only
            </label>
          }
        />
        <ul className="divide-y divide-border">
          {shownTeams.length === 0 && <li className="px-5 py-6 text-center text-[13px] text-muted">No teams to show.</li>}
          {shownTeams.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3" data-team={t.slug}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-[12px] text-subtle">/{t.slug}</span>
                  {t.overQuota.length > 0 && <Badge tone="danger">Over quota</Badge>}
                  {!t.overQuota.length && t.nearQuota > 0 && <Badge tone="warning">Near limit</Badge>}
                </div>
                <p className="mt-0.5 text-[12px] text-muted">
                  {t.counts.projects} projects · {t.counts.baseProjects} backends · {t.counts.memberships} members ·{" "}
                  {t.source === "assigned" ? t.plan.name : `${t.plan.name} (automatic)`}
                </p>
                {t.overQuota.length > 0 && (
                  <p className="mt-1 text-[12px] text-danger">
                    {t.overQuota.map((o) => `${o.label}${o.scope ? ` (${o.scope.name})` : ""}: ${fmtValue(o.used, o.unit)} / ${fmtLimit(o.limit, o.unit)}`).join(" · ")}
                  </p>
                )}
              </div>
              <Select
                aria-label={`Plan for ${t.name}`}
                className="w-44"
                value={t.source === "assigned" ? (t.plan.id ?? "") : ""}
                disabled={busy === t.slug}
                onChange={(e) => assign(t.slug, e.target.value || null)}
                options={planOptions}
              />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
