"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, CircleAlert, Clock, ExternalLink, GitBranch, Globe, Lock, MoreHorizontal, RefreshCw, Star } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CopyButton,
  Dialog,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  Field,
  Input,
  Select,
  Switch,
  useToast,
} from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";
import type { DomainDTO } from "@/lib/domains/service";

type Config = { platformDomain: string; serverIps: string[]; cnameTarget: string };

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { ACTIVE: "success", PENDING: "warning", VERIFYING: "warning", FAILED: "danger", DISABLED: "neutral" };
const STATUS_LABEL: Record<string, string> = { ACTIVE: "Valid configuration", PENDING: "Pending verification", VERIFYING: "Verifying", FAILED: "Invalid configuration", DISABLED: "Disabled" };

export function DomainsClient({
  projectId,
  productionBranch,
  canEdit,
  initial,
  config,
  branches,
}: {
  projectId: string;
  productionBranch: string;
  canEdit: boolean;
  initial: DomainDTO[];
  config: Config;
  branches: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [domains, setDomains] = useState(initial);
  const [hostname, setHostname] = useState("");
  const [withWww, setWithWww] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ kind: "redirect" | "branch" | "rename"; d: DomainDTO } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<DomainDTO | null>(null);

  useEffect(() => setDomains(initial), [initial]);

  const reload = async () => {
    try {
      const r = await api<{ items: DomainDTO[] }>(`/api/v1/projects/${projectId}/domains`);
      setDomains(r.items);
    } catch {}
  };

  // poll while something is waiting for DNS
  const waiting = domains.some((d) => d.status === "PENDING" || d.status === "VERIFYING");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const r = await api<{ items: DomainDTO[] }>(`/api/v1/projects/${projectId}/domains`, { body: { hostname, withWww } });
      toast.success(`Added ${r.items.map((d) => d.hostname).join(" and ")}`, "Configure the DNS records below — we check automatically.");
      setHostname("");
      await reload();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? (err.fields?.hostname ?? err.message) : "Could not add the domain");
    } finally {
      setAdding(false);
    }
  };

  const patch = async (d: DomainDTO, body: Record<string, unknown>, ok: string) => {
    try {
      await api(`/api/v1/projects/${projectId}/domains/${d.id}`, { method: "PATCH", body });
      toast.success(ok);
      await reload();
      return true;
    } catch (err) {
      toast.error("Update failed", err instanceof ApiClientError ? err.message : undefined);
      return false;
    }
  };

  const verify = async (d: DomainDTO) => {
    try {
      const r = await api<{ domain: DomainDTO }>(`/api/v1/projects/${projectId}/domains/${d.id}/verify`, { method: "POST" });
      if (r.domain.status === "ACTIVE") toast.success(`${d.hostname} is configured correctly`);
      else toast.info(`${d.hostname} is not configured yet`, r.domain.lastError ?? undefined);
      await reload();
    } catch (err) {
      toast.error("Verification failed", err instanceof ApiClientError ? err.message : undefined);
    }
  };

  const remove = async (d: DomainDTO) => {
    try {
      await api(`/api/v1/projects/${projectId}/domains/${d.id}`, { method: "DELETE" });
      toast.success(`Removed ${d.hostname}`);
      setConfirmRemove(null);
      await reload();
    } catch (err) {
      toast.error("Could not remove the domain", err instanceof ApiClientError ? err.message : undefined);
    }
  };

  const custom = domains.filter((d) => d.kind === "CUSTOM");

  return (
    <div className="space-y-6">
      {canEdit && (
        <Card>
          <CardHeader title="Add a domain" description="Point your domain at this server, then we verify DNS and issue an HTTPS certificate automatically." />
          <CardBody>
            <form id="add-domain" onSubmit={add} className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label="Domain"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="example.com or *.example.com"
                  invalid={!!error}
                  prefix={<Globe className="h-4 w-4" />}
                  autoComplete="off"
                  spellCheck={false}
                />
                {error && <p className="mt-1.5 text-[13px] text-danger">{error}</p>}
                {!error && hostname.trim().startsWith("*.") && (
                  <p className="mt-1.5 text-[13px] text-muted">
                    Wildcard domain: every <span className="font-mono text-fg">name.{hostname.trim().slice(2) || "example.com"}</span> is served by this project
                    (one level deep; hostnames added explicitly elsewhere still win). Ownership is verified with a TXT record on{" "}
                    <span className="font-mono text-fg">{hostname.trim().slice(2) || "example.com"}</span>; each subdomain gets its own certificate on its first visit.
                  </p>
                )}
              </div>
              <Button type="submit" variant="primary" loading={adding} disabled={!hostname.trim()}>
                Add
              </Button>
            </form>
          </CardBody>
          <CardFooter hint={<span>Also add the {hostname.startsWith("www.") ? "apex" : "www"} variant redirecting here (308){hostname.trim().startsWith("*.") ? " — not for wildcards" : ""}</span>}>
            <Switch checked={withWww && !hostname.trim().startsWith("*.")} onCheckedChange={setWithWww} label="www redirect" disabled={hostname.trim().startsWith("*.")} />
          </CardFooter>
        </Card>
      )}

      <div className="space-y-3">
        {domains.map((d) => (
          <DomainCard
            key={d.id}
            d={d}
            config={config}
            canEdit={canEdit}
            productionBranch={productionBranch}
            onVerify={() => verify(d)}
            onPrimary={() => patch(d, { isPrimary: true }, `${d.hostname} is now the primary domain`)}
            onEdit={(kind) => setEdit({ kind, d })}
            onRemove={() => setConfirmRemove(d)}
          />
        ))}
        {!custom.length && (
          <EmptyState
            icon={<Globe className="h-5 w-5" />}
            title="No custom domains yet"
            description={`Your project is live on its free ${config.platformDomain} subdomain. Add your own domain to serve it from example.com.`}
          />
        )}
      </div>

      <EditDialog
        state={edit}
        domains={domains}
        branches={branches}
        platformDomain={config.platformDomain}
        onClose={() => setEdit(null)}
        onSave={async (body, msg) => {
          if (edit && (await patch(edit.d, body, msg))) setEdit(null);
        }}
      />

      <Dialog
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        title="Remove domain"
        description={confirmRemove ? `${confirmRemove.hostname} will stop serving this project immediately.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => confirmRemove && remove(confirmRemove)}>
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}

function DomainCard({
  d,
  config,
  canEdit,
  productionBranch,
  onVerify,
  onPrimary,
  onEdit,
  onRemove,
}: {
  d: DomainDTO;
  config: Config;
  canEdit: boolean;
  productionBranch: string;
  onVerify: () => Promise<void>;
  onPrimary: () => void;
  onEdit: (k: "redirect" | "branch" | "rename") => void;
  onRemove: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const ok = d.status === "ACTIVE";
  const showDns = d.kind === "CUSTOM" && !ok;
  return (
    <Card>
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {ok ? <Lock className="h-3.5 w-3.5 text-success" /> : <CircleAlert className="h-3.5 w-3.5 text-warning" />}
            {d.wildcard ? (
              <span className="truncate font-medium">{d.hostname}</span>
            ) : (
              <>
                <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
                  {d.hostname}
                </a>
                <ExternalLink className="h-3 w-3 text-subtle" />
              </>
            )}
            {d.wildcard && <Badge tone="outline">Wildcard</Badge>}
            {d.isPrimary && (
              <Badge tone="accent" icon={<Star className="h-3 w-3" />}>
                Primary
              </Badge>
            )}
            {d.kind === "PLATFORM" && <Badge tone="outline">Free domain</Badge>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
            </span>
            {d.redirectTo ? (
              <span className="inline-flex items-center gap-1">
                <ArrowRight className="h-3.5 w-3.5" /> Redirects ({d.redirectStatus ?? 308}) to <span className="font-mono text-fg">{d.redirectTo}</span>
              </span>
            ) : d.gitBranch ? (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="h-3.5 w-3.5" /> Branch <span className="font-mono text-fg">{d.gitBranch}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="h-3.5 w-3.5" /> Production ({productionBranch})
              </span>
            )}
            {d.kind === "CUSTOM" && d.lastCheckedAt && (
              <span className="inline-flex items-center gap-1" suppressHydrationWarning>
                <Clock className="h-3.5 w-3.5" /> Checked {timeAgo(d.lastCheckedAt)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {d.kind === "CUSTOM" && canEdit && (
            <Button
              size="sm"
              variant={ok ? "ghost" : "secondary"}
              loading={busy}
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={async () => {
                setBusy(true);
                await onVerify();
                setBusy(false);
              }}
            >
              {ok ? "Refresh" : "Verify now"}
            </Button>
          )}
          {canEdit && (
            <Dropdown
              trigger={() => (
                <span className="inline-flex rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Domain actions" role="button">
                  <MoreHorizontal className="h-4 w-4" />
                </span>
              )}
              align="end"
            >
              {(close: () => void) => (
                <>
                  {!d.isPrimary && !d.redirectTo && (
                    <DropdownItem icon={<Star className="h-3.5 w-3.5" />} onClick={() => (close(), onPrimary())}>
                      Set as primary
                    </DropdownItem>
                  )}
                  {d.kind === "PLATFORM" && (
                    <DropdownItem icon={<Globe className="h-3.5 w-3.5" />} onClick={() => (close(), onEdit("rename"))}>
                      Rename subdomain
                    </DropdownItem>
                  )}
                  {!d.wildcard && (
                    <DropdownItem icon={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => (close(), onEdit("redirect"))}>
                      {d.redirectTo ? "Edit redirect" : "Redirect to another domain"}
                    </DropdownItem>
                  )}
                  {d.kind === "CUSTOM" && (
                    <DropdownItem icon={<GitBranch className="h-3.5 w-3.5" />} onClick={() => (close(), onEdit("branch"))}>
                      Assign to a git branch
                    </DropdownItem>
                  )}
                  {d.kind === "CUSTOM" && (
                    <>
                      <DropdownSeparator />
                      <DropdownItem danger onClick={() => (close(), onRemove())}>
                        Remove
                      </DropdownItem>
                    </>
                  )}
                </>
              )}
            </Dropdown>
          )}
        </div>
      </div>
      {showDns && <DnsInstructions d={d} config={config} />}
    </Card>
  );
}

function DnsInstructions({ d, config }: { d: DomainDTO; config: Config }) {
  const routing = d.dns.filter((r) => r.purpose === "routing");
  const primary = routing.filter((r) => !r.alternative);
  const alt = routing.filter((r) => r.alternative);
  const txt = d.dns.filter((r) => r.purpose === "ownership");
  const Row = ({ r }: { r: DomainDTO["dns"][number] }) => (
    <tr className="border-t border-border">
      <td className="py-2 pr-4 font-mono text-[13px]">{r.type}</td>
      <td className="py-2 pr-4 font-mono text-[13px]">
        <span className="inline-flex items-center gap-1">
          {r.name}
          <CopyButton value={r.name} className="h-6 w-6" label="" />
        </span>
      </td>
      <td className="py-2 font-mono text-[13px]">
        <span className="inline-flex items-center gap-1 break-all">
          {r.value}
          <CopyButton value={r.value} className="h-6 w-6" label="" />
        </span>
      </td>
    </tr>
  );
  const check = d.check;
  return (
    <div className="border-t border-border bg-bg-subtle px-5 py-4">
      {d.lastError && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-warning">
          <CircleAlert className="h-3.5 w-3.5" /> {d.lastError}
        </p>
      )}
      <p className="text-[13px] text-muted">Set the following records at your DNS provider:</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left">
          <thead>
            <tr className="text-[12px] uppercase tracking-wide text-subtle">
              <th className="pb-1 pr-4 font-medium">Type</th>
              <th className="pb-1 pr-4 font-medium">Name</th>
              <th className="pb-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {primary.map((r, i) => (
              <Row key={`p${i}`} r={r} />
            ))}
            {txt.map((r, i) => (
              <Row key={`t${i}`} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      {alt.length > 0 && (
        <p className="mt-3 text-[13px] text-muted">
          Can&apos;t use a CNAME? Use an <span className="font-mono">A</span> record to <span className="font-mono text-fg">{alt.map((a) => a.value).join(", ")}</span> instead.
        </p>
      )}
      {!config.serverIps.length && <p className="mt-2 text-[13px] text-warning">The platform owner hasn&apos;t configured SERVER_IPS — any A record is accepted.</p>}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-subtle">
        <span className="inline-flex items-center gap-1">
          {check?.routing ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <CircleAlert className="h-3.5 w-3.5" />} Points to this server
        </span>
        <span className="inline-flex items-center gap-1">
          {check?.ownership ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <CircleAlert className="h-3.5 w-3.5" />} Ownership TXT record
        </span>
        {d.nextCheckAt && <span suppressHydrationWarning>Next automatic check at {new Date(d.nextCheckAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
    </div>
  );
}

function EditDialog({
  state,
  domains,
  branches,
  platformDomain,
  onClose,
  onSave,
}: {
  state: { kind: "redirect" | "branch" | "rename"; d: DomainDTO } | null;
  domains: DomainDTO[];
  branches: string[];
  platformDomain: string;
  onClose: () => void;
  onSave: (body: Record<string, unknown>, msg: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("308");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!state) return;
    const d = state.d;
    if (state.kind === "redirect") {
      setValue(d.redirectTo ?? "");
      setStatus(String(d.redirectStatus ?? 308));
    } else if (state.kind === "branch") setValue(d.gitBranch ?? "");
    else setValue(d.hostname.replace(`.${platformDomain}`, ""));
  }, [state, platformDomain]);
  if (!state) return null;
  const d = state.d;
  const targets = domains.filter((x) => x.id !== d.id && !x.redirectTo && !x.wildcard).map((x) => ({ value: x.hostname, label: x.hostname }));
  const save = async () => {
    setBusy(true);
    if (state.kind === "redirect")
      await onSave(value ? { redirectTo: value, redirectStatus: Number(status) } : { redirectTo: null }, value ? `${d.hostname} now redirects to ${value}` : "Redirect removed");
    else if (state.kind === "branch") await onSave({ gitBranch: value || null }, value ? `${d.hostname} now serves branch ${value}` : `${d.hostname} now serves production`);
    else await onSave({ subdomain: value }, `Renamed to ${value}.${platformDomain}`);
    setBusy(false);
  };
  const title = state.kind === "redirect" ? "Redirect" : state.kind === "branch" ? "Git branch" : "Rename free domain";
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={d.hostname}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {state.kind === "redirect" && (
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <Field label="Redirect to" htmlFor="rd-target">
            <Select id="rd-target" value={value} onChange={(e) => setValue(e.target.value)} options={[{ value: "", label: "No redirect (serve the app)" }, ...targets]} />
          </Field>
          <Field label="Status" htmlFor="rd-status">
            <Select
              id="rd-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              disabled={!value}
              options={[
                { value: "308", label: "308 Permanent" },
                { value: "301", label: "301 Permanent" },
                { value: "307", label: "307 Temporary" },
                { value: "302", label: "302 Temporary" },
              ]}
            />
          </Field>
        </div>
      )}
      {state.kind === "branch" && (
        <Field label="Branch" htmlFor="br" hint="The domain serves the latest deployment of this branch. Leave empty for production.">
          <Input id="br" list="branches" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. staging" />
          <datalist id="branches">
            {branches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </Field>
      )}
      {state.kind === "rename" && (
        <Field label="Subdomain" htmlFor="sub" hint="Old links stop working immediately.">
          <Input id="sub" value={value} onChange={(e) => setValue(e.target.value.toLowerCase())} suffix={<span className="text-[13px] text-muted">.{platformDomain}</span>} />
        </Field>
      )}
    </Dialog>
  );
}
