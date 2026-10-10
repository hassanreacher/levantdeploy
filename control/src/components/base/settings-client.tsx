"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, RefreshCw, RotateCcw, Unlink, Link2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CopyButton, Input, Select, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { BASE_SERVICES, type BaseProjectDTO } from "@/lib/base-ui/shared";
import { TypedConfirmDialog } from "./confirm-dialog";

const errMsg = (e: unknown) => (e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined);

function useCall() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (key: string, fn: () => Promise<unknown>, ok?: string, hint?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast.success(ok, hint);
      router.refresh();
      return r;
    } catch (e) {
      toast.error("Action failed", errMsg(e));
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, call, router, toast };
}

export function ResumeButton({ refId }: { refId: string }) {
  const { busy, call } = useCall();
  return (
    <Button size="sm" variant="primary" loading={busy === "resume"} leftIcon={<Play className="h-3.5 w-3.5" />} onClick={() => call("resume", () => api(`/api/v1/base/projects/${refId}/actions`, { body: { action: "resume" } }), "Restoring project…")}>
      Restore project
    </Button>
  );
}

type DomainView = { hostname: string; status: string; lastError: string | null; records: { type: string; name: string; value: string; purpose: string; alternative?: boolean }[] } | null;

export function BaseSettingsClient({
  base,
  teamSlug,
  isAdmin,
  canUse,
  transferTeams,
  attachable,
  domain: initialDomain,
  versions,
  standalonePath,
}: {
  base: BaseProjectDTO;
  teamSlug: string;
  isAdmin: boolean;
  canUse: boolean;
  transferTeams: { slug: string; name: string }[];
  attachable: { id: string; slug: string; name: string }[];
  domain: DomainView;
  versions: { current: Record<string, string>; latest: Record<string, string>; upgradeAvailable: boolean };
  /** where to go after detaching from a project (the standalone page) */
  standalonePath: string;
}) {
  const { busy, call, router, toast } = useCall();
  const [name, setName] = useState(base.name);
  const [service, setService] = useState("");
  const [host, setHost] = useState(initialDomain?.hostname ?? "");
  const [domain, setDomain] = useState<DomainView>(initialDomain);
  const [attachTo, setAttachTo] = useState(attachable[0]?.id ?? "");
  const [target, setTarget] = useState(transferTeams[0]?.slug ?? "");
  const [dialog, setDialog] = useState<"delete" | "transfer" | "pause" | null>(null);
  const [verifying, setVerifying] = useState(false);
  const p = `/api/v1/base/projects/${base.ref}`;
  const running = base.status === "ACTIVE";
  const action = (a: string, extra: Record<string, unknown> = {}, ok?: string) => call(a, () => api(`${p}/actions`, { body: { action: a, ...extra } }), ok);
  const changed = Object.keys(versions.current).filter((k) => versions.latest[k] && versions.latest[k] !== versions.current[k]);

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader title="Project name" description="Shown in the dashboard. The project reference and URL never change." />
        <CardBody className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={63} disabled={!isAdmin} aria-label="Project name" className="max-w-sm" />
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            Reference <code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-fg">{base.ref}</code>
            <CopyButton value={base.ref} label="Copy reference" />
          </div>
        </CardBody>
        <CardFooter hint="Admins only.">
          <Button size="sm" variant="primary" disabled={!isAdmin || !name.trim() || name.trim() === base.name} loading={busy === "name"} onClick={() => call("name", () => api(p, { method: "PATCH", body: { name: name.trim() } }), "Renamed")}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Project availability" description="Pausing stops every container (no CPU or memory used); data and settings are kept. Restoring starts it again in about a minute." />
        <CardBody>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            Current state: <Badge tone={running ? "success" : base.status === "PAUSED" ? "neutral" : "warning"}>{base.status.toLowerCase()}</Badge>
          </div>
        </CardBody>
        <CardFooter hint="Free plan projects are paused automatically after 7 days without API requests.">
          {base.status === "PAUSED" ? (
            <Button size="sm" variant="primary" disabled={!isAdmin} loading={busy === "resume"} leftIcon={<Play className="h-3.5 w-3.5" />} onClick={() => action("resume", {}, "Restoring project…")}>
              Restore project
            </Button>
          ) : (
            <Button size="sm" disabled={!isAdmin || !running} leftIcon={<Pause className="h-3.5 w-3.5" />} onClick={() => setDialog("pause")}>
              Pause project
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Restart services" description="Restart the whole stack, or a single service after a configuration change." />
        <CardBody>
          <Select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="max-w-xs"
            aria-label="Service"
            options={[{ value: "", label: "All services" }, ...BASE_SERVICES.filter((s) => s.id !== "studio").map((s) => ({ value: s.id, label: s.label }))]}
          />
        </CardBody>
        <CardFooter hint={service ? "Members can restart single services." : "Restarting everything causes a short API outage."}>
          <Button
            size="sm"
            disabled={!running || !(service ? canUse : isAdmin)}
            loading={busy === "restart"}
            leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => action("restart", service ? { service } : {}, `Restarting ${service || "all services"}…`)}
          >
            Restart
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Service versions" description="Images this project runs. Upgrades take a backup first and recreate the changed services." />
        <CardBody>
          {Object.keys(versions.current).length ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-[13px]">
                <thead className="bg-bg-subtle text-left text-[12px] text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Service</th>
                    <th className="px-3 py-2 font-medium">Current</th>
                    <th className="px-3 py-2 font-medium">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(versions.current).map(([k, v]) => (
                    <tr key={k} className="border-t border-border">
                      <td className="px-3 py-2">{k}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[12px]">{v}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[12px]">
                        {versions.latest[k] && versions.latest[k] !== v ? <span className="text-accent">{versions.latest[k]}</span> : <span className="text-subtle">up to date</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[13px] text-muted">Versions are recorded once the stack is provisioned.</p>
          )}
        </CardBody>
        <CardFooter hint={versions.upgradeAvailable ? `${changed.length} service${changed.length === 1 ? "" : "s"} can be upgraded.` : "Everything is up to date."}>
          <Button size="sm" disabled={!isAdmin || !running || !versions.upgradeAvailable} loading={busy === "upgrade"} leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => action("upgrade", {}, "Upgrade started")}>
            Upgrade
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Custom API domain" description={<>Serve the API from your own domain (e.g. <span className="font-mono">api.example.com</span>) instead of {new URL(base.apiUrl).host}. HTTPS is automatic.</>} />
        <CardBody className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="api.example.com" disabled={!isAdmin} className="font-mono sm:max-w-sm" aria-label="Custom domain" />
            <Button
              size="md"
              disabled={!isAdmin || !host.trim() || host.trim() === domain?.hostname}
              loading={busy === "domain"}
              onClick={async () => {
                const r = (await call("domain", () => api<{ domain: DomainView }>(`${p}/domain`, { method: "PUT", body: { hostname: host.trim() } }), "Domain saved", "Add the DNS records below, then verify.")) as { domain: DomainView } | null;
                if (r) setDomain(r.domain);
              }}
            >
              Save
            </Button>
          </div>
          {domain && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-mono">{domain.hostname}</span>
                <Badge tone={domain.status === "ACTIVE" ? "success" : domain.status === "FAILED" ? "danger" : "warning"}>{domain.status.toLowerCase()}</Badge>
                {domain.lastError && <span className="text-[12px] text-danger">{domain.lastError}</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Type</th>
                      <th className="py-1 pr-3 font-medium">Name</th>
                      <th className="py-1 font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {domain.records.filter((r) => !r.alternative).map((r) => (
                      <tr key={`${r.type}${r.name}`} className="border-t border-border">
                        <td className="py-1.5 pr-3">{r.type}</td>
                        <td className="py-1.5 pr-3">{r.name}</td>
                        <td className="flex items-center gap-1 py-1.5">
                          <span className="truncate">{r.value}</span>
                          <CopyButton value={r.value} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardBody>
        <CardFooter hint="Admins only. Uses the same DNS verification as Deploy domains.">
          {domain && (
            <>
              <Button size="sm" variant="ghost" disabled={!isAdmin} loading={busy === "domain-rm"} onClick={async () => (await call("domain-rm", () => api(`${p}/domain`, { method: "DELETE" }), "Domain removed")) && (setDomain(null), setHost(""))}>
                Remove
              </Button>
              <Button
                size="sm"
                disabled={!isAdmin}
                loading={verifying}
                onClick={async () => {
                  setVerifying(true);
                  try {
                    const r = await api<{ ok: boolean; domain: DomainView; check: { reason: string | null } }>(`${p}/domain/verify`, { method: "POST" });
                    setDomain(r.domain);
                    if (r.ok) toast.success("Domain verified");
                    else toast.error("Not verified yet", r.check.reason ?? undefined);
                    router.refresh();
                  } catch (e) {
                    toast.error("Verification failed", errMsg(e));
                  } finally {
                    setVerifying(false);
                  }
                }}
              >
                Verify
              </Button>
            </>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title="Deploy project"
          description={base.project ? <>This backend belongs to <span className="font-medium text-fg">{base.project.name}</span> and appears in its Backend tab.</> : "Attach this backend to a Deploy project: it then appears in the project's Backend tab and its env vars are written."}
        />
        {!base.project && (
          <CardBody>
            {attachable.length ? (
              <Select value={attachTo} onChange={(e) => setAttachTo(e.target.value)} options={attachable.map((x) => ({ value: x.id, label: x.name }))} className="max-w-xs" aria-label="Project" disabled={!canUse} />
            ) : (
              <p className="text-[13px] text-muted">Every project of this team already has a backend.</p>
            )}
          </CardBody>
        )}
        <CardFooter hint="Env vars stay in place when you detach.">
          {base.project ? (
            <Button
              size="sm"
              disabled={!canUse}
              loading={busy === "detach"}
              leftIcon={<Unlink className="h-3.5 w-3.5" />}
              onClick={async () => {
                if (await call("detach", () => api(`${p}/connect`, { method: "DELETE" }), "Detached")) router.push(standalonePath);
              }}
            >
              Detach
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!canUse || !attachTo}
              loading={busy === "attach"}
              leftIcon={<Link2 className="h-3.5 w-3.5" />}
              onClick={async () => {
                const proj = attachable.find((x) => x.id === attachTo)!;
                if (await call("attach", () => api(`${p}/connect`, { body: { projectId: attachTo, attach: true } }), `Attached to ${proj.name}`, "Redeploy the project to apply the new env vars."))
                  router.push(`/${teamSlug}/${proj.slug}/backend`);
              }}
            >
              Attach
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Transfer project" description="Move this backend (data, functions, settings) to another team you administer. It is detached from its Deploy project." />
        <CardBody>
          {transferTeams.length ? (
            <Select value={target} onChange={(e) => setTarget(e.target.value)} options={transferTeams.map((t) => ({ value: t.slug, label: t.name }))} className="max-w-xs" disabled={!isAdmin} aria-label="Target team" />
          ) : (
            <p className="text-[13px] text-muted">You need the admin role in another team to transfer this project.</p>
          )}
        </CardBody>
        <CardFooter hint="Admins of both teams only.">
          <Button size="sm" disabled={!isAdmin || !transferTeams.length} onClick={() => setDialog("transfer")}>
            Transfer
          </Button>
        </CardFooter>
      </Card>

      <Card className="border-danger/40">
        <CardHeader title="Delete project" description="Permanently delete this backend: the database, files, users, functions and backups. This cannot be undone." />
        <CardFooter hint="Admins only." className="border-danger/30 bg-danger/5">
          <Button size="sm" variant="danger" disabled={!isAdmin || base.status === "DELETING"} onClick={() => setDialog("delete")}>
            Delete project
          </Button>
        </CardFooter>
      </Card>

      <TypedConfirmDialog
        open={dialog === "pause"}
        onClose={() => setDialog(null)}
        title="Pause project"
        description={<>Apps using <span className="font-mono">{base.apiUrl}</span> will get errors until you restore it.</>}
        expected={base.name}
        action="Pause"
        danger={false}
        busy={busy === "pause"}
        onConfirm={async () => {
          await action("pause", {}, "Pausing project…");
          setDialog(null);
        }}
      />
      <TypedConfirmDialog
        open={dialog === "transfer"}
        onClose={() => setDialog(null)}
        title="Transfer project"
        description={<>Move <span className="font-medium text-fg">{base.name}</span> to <span className="font-medium text-fg">{transferTeams.find((t) => t.slug === target)?.name}</span>.</>}
        expected={base.name}
        action="Transfer"
        danger={false}
        busy={busy === "transfer"}
        onConfirm={async (typed) => {
          const r = (await call("transfer", () => api<{ team: { slug: string } }>(`${p}/transfer`, { body: { team: target, confirm: typed } }), "Transferred")) as { team: { slug: string } } | null;
          if (r) router.push(`/${r.team.slug}/base/${base.ref}`);
        }}
      />
      <TypedConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        title="Delete project"
        description={<>This permanently deletes <span className="font-medium text-fg">{base.name}</span> and all of its data.</>}
        expected={base.name}
        action="Delete"
        busy={busy === "delete"}
        onConfirm={async (typed) => {
          if (await call("delete", () => api(`${p}?confirm=${encodeURIComponent(typed)}`, { method: "DELETE" }), `Deleting ${base.name}…`)) router.push(base.project ? `/${teamSlug}/${base.project.slug}` : `/${teamSlug}/base`);
        }}
      />
    </div>
  );
}
