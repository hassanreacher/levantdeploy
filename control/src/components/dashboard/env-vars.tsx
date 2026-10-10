"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Eye, EyeOff, FileUp, Link2, Lock, MoreHorizontal, Pencil, Plus, Search, Trash2, TriangleAlert, Unlink, X } from "lucide-react";
import type { EnvTarget } from "@prisma/client";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { EnvItemView } from "@/lib/dashboard/env-api";
import { useDeploymentActions, type ActionDeployment } from "./deployment-actions";
import { TimeAgo } from "./time-ago";

const TARGETS: { value: EnvTarget; label: string }[] = [
  { value: "PRODUCTION", label: "Production" },
  { value: "PREVIEW", label: "Preview" },
  { value: "DEVELOPMENT", label: "Development" },
];
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Row = { key: string; value: string };

/** Parses pasted .env text in the browser (same rules as the server, simplified). */
function parsePaste(text: string): Row[] {
  const out: Row[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out.push({ key: m[1]!, value: v });
  }
  return out;
}

function TargetPicker({ value, onChange, disabled }: { value: EnvTarget[]; onChange: (v: EnvTarget[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {TARGETS.map((t) => {
        const on = value.includes(t.value);
        return (
          <label key={t.value} className={cn("inline-flex cursor-pointer items-center gap-2 text-[13px]", disabled && "cursor-not-allowed opacity-50")}>
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border-strong accent-[rgb(var(--accent))]"
              checked={on}
              disabled={disabled}
              onChange={() => onChange(on ? value.filter((x) => x !== t.value) : [...value, t.value])}
            />
            {t.label}
          </label>
        );
      })}
    </div>
  );
}

export type EnvGroupLink = { id: string; name: string; description: string | null; varCount: number };

export function EnvVarsManager({
  projectId,
  teamSlug,
  projectSlug,
  items,
  linkedGroups,
  teamGroups,
  pending,
  production,
  role,
}: {
  projectId: string;
  teamSlug: string;
  projectSlug: string;
  items: EnvItemView[];
  linkedGroups: EnvGroupLink[];
  teamGroups: EnvGroupLink[];
  pending: { changed: boolean; changedAt: string | null };
  production: ActionDeployment | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
}) {
  const router = useRouter();
  const toast = useToast();
  const canWrite = role !== "VIEWER";
  const isAdmin = role === "OWNER" || role === "ADMIN";
  const { ask, dialogs } = useDeploymentActions({ teamSlug, projectSlug });

  // ── add form
  const [rows, setRows] = useState<Row[]>([{ key: "", value: "" }]);
  const [targets, setTargets] = useState<EnvTarget[]>(["PRODUCTION", "PREVIEW", "DEVELOPMENT"]);
  const [branch, setBranch] = useState("");
  const [secret, setSecret] = useState(false);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const onlyPreview = targets.length === 1 && targets[0] === "PREVIEW";

  const setRow = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const onKeyPaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("=") && !text.includes("\n")) return;
    const parsed = parsePaste(text);
    if (!parsed.length) return;
    e.preventDefault();
    setRows((r) => {
      const before = r.slice(0, i);
      const after = r.slice(i + 1).filter((x) => x.key || x.value);
      return [...before, ...parsed, ...after];
    });
    toast.info(`Pasted ${parsed.length} variable${parsed.length === 1 ? "" : "s"}`);
  };

  const keyErrors = rows.map((r) => (r.key && !KEY_RE.test(r.key) ? "Letters, digits and _ only" : null));
  const dupes = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((r) => {
      if (!r.key) return false;
      const d = seen.has(r.key);
      seen.add(r.key);
      return d;
    });
  }, [rows]);
  const filled = rows.filter((r) => r.key);
  const canSave = canWrite && filled.length > 0 && targets.length > 0 && !keyErrors.some(Boolean) && !dupes.some(Boolean);

  const save = async (overwrite = false) => {
    setSaving(true);
    try {
      const r = await api<{ created: number; updated: number }>(`/api/v1/projects/${projectId}/env`, {
        method: "POST",
        body: { items: filled.map((x) => ({ key: x.key.trim(), value: x.value, targets, isSecret: secret, branch: onlyPreview && branch.trim() ? branch.trim() : null, comment: comment.trim() || null })), overwrite },
      });
      toast.success(r.updated ? `Saved ${r.created} new, updated ${r.updated}` : `Added ${r.created} variable${r.created === 1 ? "" : "s"}`, "Redeploy to apply the changes.");
      setRows([{ key: "", value: "" }]);
      setComment("");
      setBranch("");
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      if (err.status === 409 && !overwrite) setConflict(err.message);
      else toast.error("Could not save", err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setSaving(false);
    }
  };

  const importDotenv = async () => {
    setSaving(true);
    try {
      const r = await api<{ created: number; updated: number }>(`/api/v1/projects/${projectId}/env`, {
        method: "POST",
        body: { dotenv: importText, targets, isSecret: secret, branch: onlyPreview && branch.trim() ? branch.trim() : null, overwrite: true },
      });
      toast.success(`Imported ${r.created + r.updated} variables`, r.updated ? `${r.updated} existing values were replaced` : undefined);
      setImportOpen(false);
      setImportText("");
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      toast.error("Import failed", err.fields ? Object.values(err.fields).slice(0, 3).join(" · ") : err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── list
  const [q, setQ] = useState("");
  const [env, setEnv] = useState<"" | EnvTarget>("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<EnvItemView | null>(null);
  const [deleting, setDeleting] = useState<EnvItemView | null>(null);
  const shown = items.filter((i) => (!q || i.key.toLowerCase().includes(q.toLowerCase())) && (!env || i.targets.includes(env)));

  const reveal = async (it: EnvItemView) => {
    if (revealed[it.id] !== undefined) return setRevealed(({ [it.id]: _x, ...rest }) => rest);
    if (it.value !== null) return setRevealed((r) => ({ ...r, [it.id]: it.value! }));
    try {
      const r = await api<{ value: string }>(`/api/v1/projects/${projectId}/env/${it.id}/reveal`);
      setRevealed((x) => ({ ...x, [it.id]: r.value }));
    } catch (e) {
      toast.error("Can't reveal", (e as Error).message);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await api(`/api/v1/projects/${projectId}/env/${deleting.id}`, { method: "DELETE" });
      toast.success(`Removed ${deleting.key}`);
      setDeleting(null);
      router.refresh();
    } catch (e) {
      toast.error("Could not remove", (e as Error).message);
    }
  };

  const [linkSel, setLinkSel] = useState("");
  const linkable = teamGroups.filter((g) => !linkedGroups.some((l) => l.id === g.id));
  const link = async () => {
    if (!linkSel) return;
    try {
      await api(`/api/v1/projects/${projectId}/env-groups`, { method: "POST", body: { groupId: linkSel } });
      toast.success("Shared group linked");
      setLinkSel("");
      router.refresh();
    } catch (e) {
      toast.error("Could not link", (e as Error).message);
    }
  };
  const unlink = async (g: EnvGroupLink) => {
    try {
      await api(`/api/v1/projects/${projectId}/env-groups/${g.id}`, { method: "DELETE" });
      toast.success(`Unlinked ${g.name}`);
      router.refresh();
    } catch (e) {
      toast.error("Could not unlink", (e as Error).message);
    }
  };

  return (
    <div className="space-y-8">
      {pending.changed && (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center" role="status" data-testid="redeploy-banner">
          <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
          <p className="flex-1 text-[13px] text-fg">
            Environment variables changed <TimeAgo date={pending.changedAt} className="text-muted" />. A new deployment is required for your changes to take effect.
          </p>
          {production && canWrite && (
            <Button size="sm" variant="primary" onClick={() => ask("redeploy", production)}>
              Redeploy
            </Button>
          )}
        </div>
      )}

      {canWrite && (
        <Card>
          <CardHeader
            title="Add Environment Variable"
            description="Values are encrypted at rest (AES-256-GCM). Paste a .env file into the Key field to add many at once."
            actions={
              <Button size="sm" variant="ghost" leftIcon={<FileUp className="h-3.5 w-3.5" />} onClick={() => setImportOpen(true)}>
                Import .env
              </Button>
            }
          />
          <CardBody className="space-y-4">
            <div className="space-y-2">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_36px] gap-2 text-[12px] font-medium text-subtle sm:grid">
                <span>Key</span>
                <span>Value</span>
              </div>
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_36px] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_36px]">
                  <div>
                    <Input
                      value={r.key}
                      onChange={(e) => setRow(i, { key: e.target.value.replace(/\s/g, "_") })}
                      onPaste={(e) => onKeyPaste(i, e)}
                      placeholder="e.g. CLIENT_KEY"
                      className="font-mono"
                      invalid={!!keyErrors[i] || dupes[i]}
                      aria-label="Key"
                      spellCheck={false}
                    />
                    {(keyErrors[i] || dupes[i]) && <p className="mt-1 text-xs text-danger">{keyErrors[i] ?? "Duplicate key"}</p>}
                  </div>
                  <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
                    <Textarea
                      value={r.value}
                      onChange={(e) => setRow(i, { value: e.target.value })}
                      placeholder="Value"
                      className="!min-h-[36px] font-mono"
                      rows={1}
                      aria-label="Value"
                      spellCheck={false}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove row"
                    className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto"
                    onClick={() => setRows((x) => (x.length === 1 ? [{ key: "", value: "" }] : x.filter((_, j) => j !== i)))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRows((r) => [...r, { key: "", value: "" }])}>
                Add Another
              </Button>
            </div>
            <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
              <div>
                <p className="mb-2 text-[13px] font-medium text-muted">Environments</p>
                <TargetPicker value={targets} onChange={setTargets} />
                {targets.length === 0 && <p className="mt-1.5 text-xs text-danger">Select at least one environment</p>}
                {onlyPreview && (
                  <div className="mt-3">
                    <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="All preview branches (optional: feat/x)" prefix="branch" className="font-mono" aria-label="Preview branch" />
                    <p className="mt-1 text-xs text-subtle">Branch-specific values override the general preview value.</p>
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <label className="flex items-center justify-between gap-4 rounded-md border border-border bg-bg-subtle px-3 py-2.5">
                  <span>
                    <span className="block text-[13px] font-medium text-fg">Sensitive</span>
                    <span className="block text-[12px] text-muted">Value is hidden after saving; only admins can reveal it.</span>
                  </span>
                  <Switch checked={secret} onCheckedChange={setSecret} label="Sensitive" />
                </label>
                <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Note (optional)" maxLength={500} aria-label="Note" />
              </div>
            </div>
          </CardBody>
          <CardFooter hint={<span className="hidden sm:inline">A new deployment is required for changes to take effect.</span>}>
            <Button size="sm" variant="primary" disabled={!canSave} loading={saving} onClick={() => save()}>
              Save
            </Button>
          </CardFooter>
        </Card>
      )}

      <section>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search variables…"
              aria-label="Search variables"
              className="h-9 w-full rounded-md border border-border bg-bg pl-9 pr-3 text-sm text-fg placeholder:text-subtle hover:border-border-strong focus:border-fg/40 focus:outline-none focus:ring-2 focus:ring-fg/10"
            />
          </div>
          <div className="flex gap-2">
            <Select
              value={env}
              onChange={(e) => setEnv(e.target.value as "" | EnvTarget)}
              options={[{ value: "", label: "All Environments" }, ...TARGETS]}
              className="flex-1 sm:w-48"
              aria-label="Filter by environment"
            />
            {role !== "VIEWER" && (
              <a
                href={`/api/v1/projects/${projectId}/env?format=dotenv&target=${env || "DEVELOPMENT"}`}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:border-border-strong hover:bg-surface-2"
                download=".env"
                title={`Download .env (${(env || "DEVELOPMENT").toLowerCase()})`}
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">.env</span>
              </a>
            )}
          </div>
        </div>
        {shown.length === 0 ? (
          <EmptyState title={items.length ? "No variables match" : "No environment variables yet"} description={items.length ? "Try another search or environment." : "Add variables above or link a shared env group."} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <ul className="divide-y divide-border" data-testid="env-list">
              {shown.map((it) => {
                const val = revealed[it.id];
                const canReveal = it.isSecret ? isAdmin : canWrite;
                return (
                  <li key={it.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,140px)_auto]">
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px] font-medium text-fg">{it.key}</span>
                        {it.isSecret && <Lock className="h-3 w-3 shrink-0 text-subtle" aria-label="Sensitive" />}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {it.targets.length === 3 ? (
                          <span className="text-[12px] text-muted">All Environments</span>
                        ) : (
                          it.targets.map((t) => (
                            <Badge key={t} tone="outline">
                              {t.charAt(0) + t.slice(1).toLowerCase()}
                            </Badge>
                          ))
                        )}
                        {it.branch && (
                          <Badge tone="accent" className="font-mono">
                            {it.branch}
                          </Badge>
                        )}
                      </div>
                      {it.comment && <p className="mt-1 truncate text-[12px] text-subtle">{it.comment}</p>}
                    </div>
                    <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 md:col-span-1 md:row-start-auto">
                      <code className="min-w-0 flex-1 truncate rounded-md bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-muted">{val !== undefined ? val || <em className="text-subtle">empty</em> : "••••••••••••"}</code>
                      {canReveal ? (
                        <Button variant="ghost" size="icon-sm" onClick={() => reveal(it)} aria-label={val !== undefined ? `Hide ${it.key}` : `Reveal ${it.key}`}>
                          {val !== undefined ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </Button>
                      ) : (
                        <span className="inline-flex h-8 w-8 items-center justify-center text-subtle" title={it.isSecret ? "Only admins can reveal sensitive values" : "Viewers can't see values"}>
                          <Lock className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                    <div className="hidden min-w-0 items-center gap-2 text-[12px] text-muted md:flex">
                      {it.createdBy && <Avatar name={it.createdBy.name} src={it.createdBy.avatar} size={18} />}
                      <span>
                        Updated <TimeAgo date={it.updatedAt} />
                      </span>
                    </div>
                    <div className="col-start-2 row-start-1 justify-self-end md:col-start-auto md:row-start-auto">
                      {canWrite && (
                        <Dropdown
                          align="end"
                          width={170}
                          trigger={() => (
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${it.key}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          )}
                        >
                          {(close) => (
                            <>
                              <DropdownItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => (close(), setEditing(it))}>
                                Edit
                              </DropdownItem>
                              <DropdownItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => (close(), setDeleting(it))}>
                                Remove
                              </DropdownItem>
                            </>
                          )}
                        </Dropdown>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <Card>
        <CardHeader title="Shared Environment Variables" description="Team-level groups linked to this project. Project variables with the same key win." />
        <CardBody className="space-y-3">
          {linkedGroups.length === 0 ? (
            <p className="text-[13px] text-muted">No shared groups linked.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {linkedGroups.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Link2 className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">{g.name}</p>
                    <p className="truncate text-[12px] text-muted">
                      {g.varCount} variable{g.varCount === 1 ? "" : "s"}
                      {g.description ? ` · ${g.description}` : ""}
                    </p>
                  </div>
                  {canWrite && (
                    <Button variant="ghost" size="sm" leftIcon={<Unlink className="h-3.5 w-3.5" />} onClick={() => unlink(g)}>
                      Unlink
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
        <CardFooter hint={<a href={`/${teamSlug}/settings/env-groups`} className="hover:text-fg">Manage groups in team settings</a>}>
          {canWrite && linkable.length > 0 && (
            <>
              <Select value={linkSel} onChange={(e) => setLinkSel(e.target.value)} options={[{ value: "", label: "Select a group…" }, ...linkable.map((g) => ({ value: g.id, label: g.name }))]} className="w-40 sm:w-48" aria-label="Shared group" />
              <Button size="sm" variant="secondary" onClick={link} disabled={!linkSel}>
                Link
              </Button>
            </>
          )}
        </CardFooter>
      </Card>

      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        size="lg"
        title="Import .env"
        description="Paste the contents of a .env file. Existing keys for the selected environments are overwritten."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={importDotenv} loading={saving} disabled={!importText.trim() || !targets.length}>
              Import {parsePaste(importText).length || ""} variables
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={10} className="font-mono text-[12px]" placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…\n# comments are ignored"} spellCheck={false} />
          <TargetPicker value={targets} onChange={setTargets} />
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <Switch checked={secret} onCheckedChange={setSecret} size="sm" label="Mark all as sensitive" /> Mark all as sensitive
          </label>
        </div>
      </Dialog>

      <Dialog
        open={!!conflict}
        onClose={() => setConflict(null)}
        size="sm"
        title="Variable already exists"
        description={<>{conflict} Overwrite the existing values?</>}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={saving} onClick={() => (setConflict(null), void save(true))}>
              Overwrite
            </Button>
          </>
        }
      />
      {editing && <EditEnvDialog projectId={projectId} item={editing} onClose={() => setEditing(null)} />}
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        size="sm"
        title="Remove variable"
        description={
          <>
            Remove <span className="font-mono text-fg">{deleting?.key}</span> from {deleting?.targets.map((t) => t.toLowerCase()).join(", ")}? Running deployments keep their value until the next deployment.
          </>
        }
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
      {dialogs}
    </div>
  );
}

function EditEnvDialog({ projectId, item, onClose }: { projectId: string; item: EnvItemView; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [key, setKey] = useState(item.key);
  const [value, setValue] = useState(item.value ?? "");
  const [targets, setTargets] = useState<EnvTarget[]>(item.targets);
  const [branch, setBranch] = useState(item.branch ?? "");
  const [comment, setComment] = useState(item.comment ?? "");
  const [secret, setSecret] = useState(item.isSecret);
  const [busy, setBusy] = useState(false);
  const hidden = item.value === null;
  const onlyPreview = targets.length === 1 && targets[0] === "PREVIEW";
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/projects/${projectId}/env/${item.id}`, {
        method: "PATCH",
        body: {
          key,
          ...(hidden && !value ? {} : { value }),
          targets,
          branch: onlyPreview && branch.trim() ? branch.trim() : null,
          comment: comment.trim() || null,
          ...(secret && !item.isSecret ? { isSecret: true } : {}),
        },
      });
      toast.success(`Updated ${key}`, "Redeploy to apply the change.");
      onClose();
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      toast.error("Could not update", err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit Environment Variable"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!KEY_RE.test(key) || !targets.length}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Key</p>
          <Input value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" invalid={!KEY_RE.test(key)} />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Value</p>
          <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} className="font-mono" placeholder={hidden ? "Hidden — leave empty to keep the current value" : ""} />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted">Environments</p>
          <TargetPicker value={targets} onChange={setTargets} />
          {onlyPreview && <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="All preview branches" prefix="branch" className="mt-3 font-mono" />}
        </div>
        <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Note (optional)" />
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <Switch checked={secret} onCheckedChange={(v) => (item.isSecret ? undefined : setSecret(v))} disabled={item.isSecret} size="sm" label="Sensitive" />
          {item.isSecret ? "Sensitive (can't be turned off)" : "Sensitive"}
        </label>
      </div>
    </Dialog>
  );
}
