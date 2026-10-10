"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Lock, ShieldCheck, ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type Patch = Record<string, unknown>;

function useProjectPatch(projectId: string) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (key: string, body: Patch, okMsg = "Saved") => {
    setBusy(key);
    try {
      const r = await api<{ project: { slug: string }; needsRedeploy: boolean }>(`/api/v1/projects/${projectId}`, { method: "PATCH", body });
      toast.success(okMsg, r.needsRedeploy ? "Applies to the next deployment — redeploy to use it now." : undefined);
      router.refresh();
      return r;
    } catch (e) {
      const err = e as ApiClientError;
      toast.error("Could not save", err.fields ? Object.values(err.fields)[0] : err.message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { save, busy };
}

function SettingCard({ title, description, children, hint, action }: { title: string; description?: ReactNode; children?: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {children && <CardBody>{children}</CardBody>}
      <CardFooter hint={hint}>{action}</CardFooter>
    </Card>
  );
}

// ───────────────────────────── General ─────────────────────────────

export function GeneralSettings({ project, canWrite, isAdmin, platformDomain }: { project: { id: string; name: string; slug: string; description: string | null }; canWrite: boolean; isAdmin: boolean; platformDomain: string }) {
  const { save, busy } = useProjectPatch(project.id);
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [desc, setDesc] = useState(project.description ?? "");
  return (
    <>
      <SettingCard
        title="Project Name"
        description="Used to identify your project in the dashboard, CLI and notifications."
        hint="Max 100 characters."
        action={
          <Button size="sm" variant="primary" disabled={!canWrite || !name.trim() || name === project.name} loading={busy === "name"} onClick={() => save("name", { name })}>
            Save
          </Button>
        }
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={!canWrite} className="max-w-md" aria-label="Project name" />
      </SettingCard>
      <SettingCard
        title="Project URL"
        description={
          <>
            Production is served at <span className="font-mono text-fg">{slug || "…"}.{platformDomain}</span>; deployment URLs use it as prefix.
          </>
        }
        hint="Admins only. Old platform URLs stop working (custom domains are kept)."
        action={
          <Button
            size="sm"
            variant="primary"
            disabled={!isAdmin || slug === project.slug || !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(slug)}
            loading={busy === "slug"}
            onClick={async () => {
              const r = await save("slug", { slug });
              if (r) router.replace(window.location.pathname.replace(`/${project.slug}/`, `/${r.project.slug}/`));
            }}
          >
            Save
          </Button>
        }
      >
        <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} suffix={`.${platformDomain}`} disabled={!isAdmin} className="max-w-md font-mono" aria-label="Project slug" />
      </SettingCard>
      <SettingCard
        title="Description"
        hint="Shown on the project overview."
        action={
          <Button size="sm" variant="primary" disabled={!canWrite || desc === (project.description ?? "")} loading={busy === "desc"} onClick={() => save("desc", { description: desc.trim() || null })}>
            Save
          </Button>
        }
      >
        <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} rows={2} disabled={!canWrite} aria-label="Description" />
      </SettingCard>
    </>
  );
}

// ───────────────────────────── Runtime ─────────────────────────────

export type RuntimeValues = {
  port: number;
  healthcheckPath: string | null;
  replicas: number;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  restartPolicy: string;
  autoDeploy: boolean;
  previewDeployments: boolean;
  kind: string;
};

export function RuntimeSettings({ projectId, values, canWrite, maxReplicas }: { projectId: string; values: RuntimeValues; canWrite: boolean; maxReplicas: number }) {
  const { save, busy } = useProjectPatch(projectId);
  const toast = useToast();
  const [v, setV] = useState(values);
  const [scaling, setScaling] = useState(false);
  const set = <K extends keyof RuntimeValues>(k: K, val: RuntimeValues[K]) => setV((x) => ({ ...x, [k]: val }));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const dirty = (keys: (keyof RuntimeValues)[]) => keys.some((k) => v[k] !== values[k]);

  const scaleNow = async () => {
    setScaling(true);
    try {
      await api(`/api/v1/projects/${projectId}/scale`, { method: "POST", body: { replicas: v.replicas } });
      toast.success(`Scaling to ${v.replicas} replica${v.replicas === 1 ? "" : "s"}…`);
    } catch (e) {
      const err = e as ApiClientError;
      toast.error(err.status === 404 ? "Live scaling not available yet" : "Scale failed", err.status === 404 ? "Saved — the new replica count applies on the next deployment." : err.message);
    } finally {
      setScaling(false);
    }
  };

  return (
    <>
      <SettingCard
        title="Networking & Health"
        description="The port your app listens on inside the container, and the HTTP path checked before traffic is switched."
        hint="Applies to the next deployment."
        action={
          <Button size="sm" variant="primary" disabled={!canWrite || !dirty(["port", "healthcheckPath"])} loading={busy === "net"} onClick={() => save("net", { port: v.port, healthcheckPath: v.healthcheckPath })}>
            Save
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">Port</span>
            <Input type="number" min={1} max={65535} value={v.port} onChange={(e) => set("port", Number(e.target.value))} disabled={!canWrite} className="font-mono" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">Healthcheck path</span>
            <Input value={v.healthcheckPath ?? ""} onChange={(e) => set("healthcheckPath", e.target.value || null)} placeholder={v.kind === "WORKER" ? "none (running = healthy)" : "/"} disabled={!canWrite} className="font-mono" />
          </label>
        </div>
      </SettingCard>

      <SettingCard
        title="Resources & Scaling"
        description="Replicas run behind the edge proxy with round-robin load balancing. Limits are enforced by Docker."
        hint={`Up to ${maxReplicas} replicas on this server.`}
        action={
          <>
            {v.replicas !== values.replicas && canWrite && (
              <Button size="sm" variant="secondary" loading={scaling} onClick={async () => (await save("res", { replicas: v.replicas }), scaleNow())}>
                Save & scale now
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!canWrite || !dirty(["replicas", "cpuLimit", "memoryLimitMb", "restartPolicy"])}
              loading={busy === "res"}
              onClick={() => save("res", { replicas: v.replicas, cpuLimit: v.cpuLimit, memoryLimitMb: v.memoryLimitMb, restartPolicy: v.restartPolicy })}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">Replicas</span>
            <Input type="number" min={0} max={maxReplicas} value={v.replicas} onChange={(e) => set("replicas", Number(e.target.value))} disabled={!canWrite} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">Restart policy</span>
            <Select
              value={v.restartPolicy}
              onChange={(e) => set("restartPolicy", e.target.value)}
              disabled={!canWrite}
              options={[
                { value: "unless-stopped", label: "Unless stopped (default)" },
                { value: "always", label: "Always" },
                { value: "on-failure", label: "On failure" },
                { value: "no", label: "Never" },
              ]}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">CPU limit (cores)</span>
            <Input type="number" step="0.25" min={0.05} value={v.cpuLimit ?? ""} onChange={(e) => set("cpuLimit", num(e.target.value))} placeholder="Server default" disabled={!canWrite} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">Memory limit</span>
            <Input type="number" step="64" min={32} value={v.memoryLimitMb ?? ""} onChange={(e) => set("memoryLimitMb", num(e.target.value))} placeholder="Server default" suffix="MB" disabled={!canWrite} />
          </label>
        </div>
      </SettingCard>

      <SettingCard
        title="Deployments"
        description="Control what happens when you push to Git."
        action={
          <Button size="sm" variant="primary" disabled={!canWrite || !dirty(["autoDeploy", "previewDeployments"])} loading={busy === "dep"} onClick={() => save("dep", { autoDeploy: v.autoDeploy, previewDeployments: v.previewDeployments })}>
            Save
          </Button>
        }
      >
        <div className="divide-y divide-border rounded-md border border-border">
          <ToggleRow title="Auto-deploy" description="Deploy automatically on every push to a connected branch." checked={v.autoDeploy} onChange={(x) => set("autoDeploy", x)} disabled={!canWrite} />
          <ToggleRow title="Preview deployments" description="Build every non-production branch and pull request with its own URL." checked={v.previewDeployments} onChange={(x) => set("previewDeployments", x)} disabled={!canWrite} />
        </div>
      </SettingCard>
    </>
  );
}

function ToggleRow({ title, description, checked, onChange, disabled }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <p className="text-[12px] text-muted">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

// ───────────────────────────── Protection ─────────────────────────────

export function ProtectionSettings({
  projectId,
  value,
  isAdmin,
}: {
  projectId: string;
  value: { mode: "none" | "password" | "basic"; scope: "previews" | "all"; username: string | null; hasPassword: boolean; updatedAt: string | null };
  isAdmin: boolean;
}) {
  const { save, busy } = useProjectPatch(projectId);
  const [mode, setMode] = useState(value.mode);
  const [scope, setScope] = useState(value.scope);
  const [username, setUsername] = useState(value.username ?? "levant");
  const [password, setPassword] = useState("");
  const needsPw = mode !== "none" && (!value.hasPassword || mode !== value.mode) && !password;
  const dirty = mode !== value.mode || scope !== value.scope || (mode === "basic" && username !== (value.username ?? "levant")) || !!password;
  const MODES = [
    { v: "none" as const, icon: <ShieldOff className="h-4 w-4" />, title: "Disabled", desc: "Anyone with the URL can open deployments." },
    { v: "password" as const, icon: <Lock className="h-4 w-4" />, title: "Password", desc: "Visitors enter a shared password once (cookie for 7 days)." },
    { v: "basic" as const, icon: <KeyRound className="h-4 w-4" />, title: "Basic Auth", desc: "HTTP Basic Auth with a username and password — good for APIs and bots." },
  ];
  return (
    <SettingCard
      title="Deployment Protection"
      description="Keep preview deployments (or everything) private. Applied by the edge proxy on every matching hostname."
      hint={value.mode !== "none" ? <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-success" /> Protection is on{value.scope === "all" ? " for all deployments" : " for previews"}.</span> : "Admins only."}
      action={
        <Button size="sm" variant="primary" disabled={!isAdmin || !dirty || needsPw} loading={busy === "prot"} onClick={async () => (await save("prot", { protection: { mode, scope, ...(mode === "basic" ? { username } : {}), ...(password ? { password } : {}) } }, "Protection updated")) && setPassword("")}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
          {MODES.map((m) => (
            <button
              key={m.v}
              type="button"
              role="radio"
              aria-checked={mode === m.v}
              disabled={!isAdmin}
              onClick={() => setMode(m.v)}
              className={cn("rounded-md border p-3 text-left transition-colors disabled:opacity-60", mode === m.v ? "border-fg/50 bg-surface-2" : "border-border hover:border-border-strong")}
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                {m.icon}
                {m.title}
              </span>
              <span className="mt-1 block text-[12px] text-muted">{m.desc}</span>
            </button>
          ))}
        </div>
        {mode !== "none" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="mb-1.5 block text-[13px] font-medium text-muted">Applies to</span>
              <Select
                value={scope}
                onChange={(e) => setScope(e.target.value as "previews" | "all")}
                disabled={!isAdmin}
                options={[
                  { value: "previews", label: "Preview deployments only (recommended)" },
                  { value: "all", label: "All deployments, including production domains" },
                ]}
              />
            </label>
            {mode === "basic" && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-muted">Username</span>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} disabled={!isAdmin} autoComplete="off" />
              </label>
            )}
            <label className={cn("block", mode === "password" && "sm:col-span-2")}>
              <span className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
                Password {value.hasPassword && mode === value.mode && <Badge tone="success">set</Badge>}
              </span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={value.hasPassword && mode === value.mode ? "Leave empty to keep the current password" : "At least 6 characters"} disabled={!isAdmin} autoComplete="new-password" />
            </label>
          </div>
        )}
      </div>
    </SettingCard>
  );
}

// ───────────────────────────── Danger zone ─────────────────────────────

export function DangerZone({
  project,
  teams,
  isAdmin,
  teamSlug,
  backend = null,
}: {
  project: { id: string; name: string; slug: string };
  teams: { slug: string; name: string }[];
  isAdmin: boolean;
  teamSlug: string;
  /** base-dashboard: the project's LevantBase backend → ask whether to keep or delete it */
  backend?: { ref: string; name: string } | null;
}) {
  const [backendChoice, setBackendChoice] = useState<"keep" | "delete">("keep");
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState(teams[0]?.slug ?? "");
  const [open, setOpen] = useState<"transfer" | "delete" | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (open === "delete") {
        await api(`/api/v1/projects/${project.id}?confirm=${encodeURIComponent(confirm)}${backend ? `&backend=${backendChoice}` : ""}`, { method: "DELETE" });
        toast.success(`Deleted ${project.name}`);
        router.push(`/${teamSlug}`);
      } else {
        const r = await api<{ team: { slug: string } }>(`/api/v1/projects/${project.id}/transfer`, { method: "POST", body: { team: target } });
        toast.success(`Transferred to ${teams.find((t) => t.slug === target)?.name ?? target}`);
        router.push(`/${r.team.slug}/${project.slug}`);
      }
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      toast.error(open === "delete" ? "Could not delete" : "Could not transfer", err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card className="border-border">
        <CardHeader title="Transfer Project" description="Move this project, its deployments, domains, databases and env vars to another team you administer." />
        <CardBody>
          {teams.length ? (
            <Select value={target} onChange={(e) => setTarget(e.target.value)} options={teams.map((t) => ({ value: t.slug, label: t.name }))} className="max-w-xs" disabled={!isAdmin} aria-label="Target team" />
          ) : (
            <p className="text-[13px] text-muted">You need the admin role in another team to transfer this project.</p>
          )}
        </CardBody>
        <CardFooter hint="Shared env group links are removed (groups belong to the old team).">
          <Button size="sm" variant="secondary" disabled={!isAdmin || !teams.length} onClick={() => (setConfirm(""), setOpen("transfer"))}>
            Transfer
          </Button>
        </CardFooter>
      </Card>
      <Card className="border-danger/40">
        <CardHeader title="Delete Project" description="Permanently delete this project: all deployments, containers, logs, domains and environment variables. This cannot be undone." />
        <CardFooter hint="Admins only." className="border-danger/30 bg-danger/5">
          <Button size="sm" variant="danger" disabled={!isAdmin} onClick={() => (setConfirm(""), setOpen("delete"))}>
            Delete Project
          </Button>
        </CardFooter>
      </Card>
      <Dialog
        open={!!open}
        onClose={() => !busy && setOpen(null)}
        title={open === "delete" ? "Delete Project" : "Transfer Project"}
        description={
          open === "delete" ? (
            <>
              This permanently deletes <span className="font-medium text-fg">{project.name}</span> and stops its containers.
            </>
          ) : (
            <>
              Move <span className="font-medium text-fg">{project.name}</span> to <span className="font-medium text-fg">{teams.find((t) => t.slug === target)?.name}</span>.
            </>
          )
        }
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant={open === "delete" ? "danger" : "primary"} disabled={confirm !== project.slug} loading={busy} onClick={run}>
              {open === "delete" ? "Delete" : "Transfer"}
            </Button>
          </>
        }
      >
        {open === "delete" && backend && (
          <fieldset className="mb-4 space-y-2">
            <legend className="mb-1.5 text-[13px] text-muted">
              This project has a backend: <span className="font-medium text-fg">{backend.name}</span>
            </legend>
            {(
              [
                ["keep", "Keep the backend", "It becomes a standalone Base project (data, users and functions are kept)."],
                ["delete", "Delete the backend too", "Its database, files, users, functions and backups are deleted."],
              ] as const
            ).map(([v, label, hint]) => (
              <label key={v} className={cn("flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5", backendChoice === v ? (v === "delete" ? "border-danger/50 bg-danger/5" : "border-fg/40 bg-surface-2") : "border-border")}>
                <input type="radio" name="backend" value={v} checked={backendChoice === v} onChange={() => setBackendChoice(v)} className="mt-1" />
                <span>
                  <span className="block text-[13px] font-medium">{label}</span>
                  <span className="block text-[12px] text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="block">
          <span className="mb-1.5 block text-[13px] text-muted">
            Type <span className="font-mono font-medium text-fg">{project.slug}</span> to confirm.
          </span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" autoComplete="off" />
        </label>
      </Dialog>
    </>
  );
}
