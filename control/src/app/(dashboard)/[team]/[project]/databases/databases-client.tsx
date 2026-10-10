"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Database as DbIcon, Download, Eye, EyeOff, Link2, MoreHorizontal, Play, Plus, RotateCcw, Square, Trash2, Unlink } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Dialog,
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
  useToast,
} from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import type { BackupDTO, DatabaseDTO } from "@/lib/runtime/database-api";

type Engine = { value: string; label: string; versions: string[]; defaultVersion: string };
type Creds = { user: string; password: string; database: string; host: string; port: number; internalUrl: string; publicUrl: string | null; envNames: string[] };

const STATUS: Record<string, { tone: "success" | "warning" | "danger" | "neutral"; label: string }> = {
  RUNNING: { tone: "success", label: "Running" },
  PROVISIONING: { tone: "warning", label: "Starting" },
  STOPPED: { tone: "neutral", label: "Stopped" },
  ERROR: { tone: "danger", label: "Error" },
  DELETING: { tone: "neutral", label: "Deleting" },
};
const ENGINE_MARK: Record<string, string> = { POSTGRES: "PG", MYSQL: "MY", REDIS: "RD", MONGO: "MG" };
const SCHEDULES = [
  { value: "", label: "No scheduled backups" },
  { value: "0 3 * * *", label: "Daily at 03:00 UTC" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 * * * *", label: "Hourly" },
  { value: "0 3 * * 0", label: "Weekly (Sunday 03:00)" },
];

export function DatabasesClient({
  team,
  projectId,
  canEdit,
  initial,
  available,
  engines,
}: {
  team: string;
  projectId: string;
  canEdit: boolean;
  initial: DatabaseDTO[];
  available: DatabaseDTO[];
  engines: Engine[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [conn, setConn] = useState<DatabaseDTO | null>(null);
  const [backups, setBackups] = useState<DatabaseDTO | null>(null);
  const [settings, setSettings] = useState<DatabaseDTO | null>(null);
  const [del, setDel] = useState<DatabaseDTO | null>(null);
  useEffect(() => setItems(initial), [initial]);

  const reload = async () => {
    try {
      const r = await api<{ items: DatabaseDTO[] }>(`/api/v1/projects/${projectId}/databases`);
      setItems(r.items);
    } catch {}
  };
  const busy = items.some((d) => d.status === "PROVISIONING" || d.status === "DELETING");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const call = async (fn: () => Promise<unknown>, ok: string, hint?: string) => {
    try {
      await fn();
      toast.success(ok, hint);
      await reload();
      router.refresh();
    } catch (e) {
      toast.error("Action failed", e instanceof ApiClientError ? e.message : undefined);
    }
  };
  const action = (d: DatabaseDTO, a: "start" | "stop" | "restart") => call(() => api(`/api/v1/databases/${d.id}/actions`, { body: { action: a } }), `${d.name}: ${a} requested`);
  const connect = (d: DatabaseDTO, pid: string | null) =>
    call(() => api(`/api/v1/databases/${d.id}`, { method: "PATCH", body: { projectId: pid } }), pid ? `${d.name} connected` : `${d.name} disconnected`, "Redeploy to apply the environment variables.");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted">
          Connected databases are injected as environment variables (e.g. <code className="font-mono text-fg">DATABASE_URL</code>, <code className="font-mono text-fg">REDIS_URL</code>) on the next deploy, using
          their private hostname on the internal network.
        </p>
        {canEdit && (
          <div className="flex items-center gap-2">
            {available.length > 0 && (
              <Dropdown
                align="end"
                width={260}
                trigger={() => (
                  <span role="button" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:border-border-strong">
                    <Link2 className="h-4 w-4" /> Connect existing
                  </span>
                )}
              >
                {(close) => (
                  <>
                    <DropdownLabel>Team databases</DropdownLabel>
                    {available.map((d) => (
                      <DropdownItem key={d.id} onClick={() => (close(), connect(d, projectId))}>
                        {d.name} · {d.engineLabel}
                        {d.project ? ` (used by ${d.project.slug})` : ""}
                      </DropdownItem>
                    ))}
                  </>
                )}
              </Dropdown>
            )}
            <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Create database
            </Button>
          </div>
        )}
      </div>

      {items.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((d) => (
            <Card key={d.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle font-mono text-[12px] font-semibold">{ENGINE_MARK[d.engine]}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{d.name}</span>
                      <Badge tone={STATUS[d.status]?.tone ?? "neutral"} icon={d.status === "PROVISIONING" ? <Spinner className="h-3 w-3" /> : undefined}>
                        {STATUS[d.status]?.label ?? d.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[13px] text-muted">
                      {d.engineLabel} {d.version}
                    </div>
                  </div>
                </div>
                {canEdit && (
                  <Dropdown
                    align="end"
                    trigger={() => (
                      <span role="button" aria-label="Database actions" className="inline-flex rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
                        <MoreHorizontal className="h-4 w-4" />
                      </span>
                    )}
                  >
                    {(close) => (
                      <>
                        {d.status === "STOPPED" || d.status === "ERROR" ? (
                          <DropdownItem icon={<Play className="h-3.5 w-3.5" />} onClick={() => (close(), action(d, "start"))}>
                            Start
                          </DropdownItem>
                        ) : (
                          <DropdownItem icon={<Square className="h-3.5 w-3.5" />} onClick={() => (close(), action(d, "stop"))}>
                            Stop
                          </DropdownItem>
                        )}
                        <DropdownItem icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => (close(), action(d, "restart"))}>
                          Restart
                        </DropdownItem>
                        <DropdownItem onClick={() => (close(), setSettings(d))}>Settings</DropdownItem>
                        <DropdownItem icon={<Unlink className="h-3.5 w-3.5" />} onClick={() => (close(), connect(d, null))}>
                          Disconnect from project
                        </DropdownItem>
                        <DropdownSeparator />
                        <DropdownItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => (close(), setDel(d))}>
                          Delete database
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                )}
              </div>
              <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 border-t border-border px-5 py-4 text-[13px]">
                <dt className="text-muted">Host</dt>
                <dd className="truncate font-mono">
                  {d.internalHost}:{d.port}
                </dd>
                <dt className="text-muted">Env</dt>
                <dd className="truncate font-mono">{d.envNames.join(", ")}</dd>
                <dt className="text-muted">Public</dt>
                <dd>{d.publicPort ? <span className="font-mono">port {d.publicPort}</span> : <span className="text-subtle">Internal only</span>}</dd>
                <dt className="text-muted">Backups</dt>
                <dd className="truncate">
                  {d.backupSchedule ? <span className="font-mono">{d.backupSchedule}</span> : <span className="text-subtle">Manual only</span>}
                  {d.lastBackup && (
                    <span className="text-subtle" suppressHydrationWarning>
                      {" "}
                      · last {timeAgo(d.lastBackup.createdAt)} {d.lastBackup.status !== "SUCCESS" && `(${d.lastBackup.status.toLowerCase()})`}
                    </span>
                  )}
                </dd>
              </dl>
              {d.lastError && d.status === "ERROR" && <p className="mx-5 mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{d.lastError}</p>}
              <div className="mt-auto flex flex-wrap gap-2 border-t border-border px-5 py-3">
                {canEdit && (
                  <Button size="sm" variant="secondary" leftIcon={<Eye className="h-3.5 w-3.5" />} onClick={() => setConn(d)} disabled={d.status === "DELETING"}>
                    Connection
                  </Button>
                )}
                <Button size="sm" variant="ghost" leftIcon={<Archive className="h-3.5 w-3.5" />} onClick={() => setBackups(d)}>
                  Backups
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<DbIcon className="h-5 w-5" />}
          title="No databases connected"
          description="Create a database next to your app — credentials are generated and injected automatically."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create database
              </Button>
            ) : undefined
          }
        />
      )}

      {creating && (
        <CreateDialog
          team={team}
          projectId={projectId}
          engines={engines}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await reload();
            router.refresh();
          }}
        />
      )}
      {conn && <ConnectionDialog d={conn} onClose={() => setConn(null)} />}
      {backups && <BackupsDialog d={backups} canEdit={canEdit} onClose={() => setBackups(null)} />}
      {settings && (
        <SettingsDialog
          d={settings}
          onClose={() => setSettings(null)}
          onSaved={async () => {
            setSettings(null);
            await reload();
          }}
        />
      )}
      <Dialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`Delete ${del?.name ?? ""}`}
        description="The container, its data volume and all backups are deleted. This cannot be undone."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const d = del!;
                setDel(null);
                await call(() => api(`/api/v1/databases/${d.id}`, { method: "DELETE" }), `Deleting ${d.name}`);
              }}
            >
              Delete forever
            </Button>
          </>
        }
      />
    </div>
  );
}

function CreateDialog({ team, projectId, engines, onClose, onCreated }: { team: string; projectId: string; engines: Engine[]; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [engine, setEngine] = useState(engines[0]!.value);
  const eng = engines.find((e) => e.value === engine)!;
  const [version, setVersion] = useState(eng.defaultVersion);
  const [name, setName] = useState("main");
  const [connectIt, setConnectIt] = useState(true);
  const [pub, setPub] = useState(false);
  const [schedule, setSchedule] = useState("0 3 * * *");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => setVersion(eng.defaultVersion), [eng.defaultVersion]);
  const create = async () => {
    setBusy(true);
    setFields({});
    try {
      await api(`/api/v1/teams/${team}/databases`, {
        body: { name, engine, version, projectId: connectIt ? projectId : null, publicAccess: pub, backupSchedule: schedule || null },
      });
      toast.success(`Creating ${name}`, "The container starts in a few seconds.");
      onCreated();
    } catch (e) {
      if (e instanceof ApiClientError) {
        setFields(e.fields ?? {});
        if (!e.fields) toast.error("Could not create the database", e.message);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Create database"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create} disabled={!name}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {engines.map((e) => (
            <button
              key={e.value}
              type="button"
              onClick={() => setEngine(e.value)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                engine === e.value ? "border-fg bg-surface-2" : "border-border hover:border-border-strong",
              )}
            >
              <span className="font-mono text-[12px] font-semibold text-muted">{ENGINE_MARK[e.value]}</span>
              <span className="text-sm font-medium">{e.label}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="Name" htmlFor="db-name" error={fields.name} hint="Also the database / user name.">
            <Input id="db-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </Field>
          <Field label="Version" htmlFor="db-version" error={fields.version}>
            <Select id="db-version" value={version} onChange={(e) => setVersion(e.target.value)} options={eng.versions.map((v) => ({ value: v, label: v }))} />
          </Field>
        </div>
        <Field label="Scheduled backups" htmlFor="db-sched" error={fields.backupSchedule}>
          <Select id="db-sched" value={schedule} onChange={(e) => setSchedule(e.target.value)} options={SCHEDULES} />
        </Field>
        <div className="divide-y divide-border rounded-lg border border-border">
          <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
            <span>
              Connect to this project
              <span className="block text-[12px] text-muted">Injects the connection string env vars on the next deploy.</span>
            </span>
            <Switch checked={connectIt} onCheckedChange={setConnectIt} />
          </label>
          <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
            <span>
              Public access
              <span className="block text-[12px] text-muted">Expose a port on the server for external tools. Keep it off unless you need it.</span>
            </span>
            <Switch checked={pub} onCheckedChange={setPub} />
          </label>
        </div>
      </div>
    </Dialog>
  );
}

function Secret({ label, value, mono = true, reveal }: { label: string; value: string; mono?: boolean; reveal: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[12px] text-muted">{label}</div>
      <div className="flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5">
        <span className={cn("min-w-0 flex-1 truncate text-[13px]", mono && "font-mono")}>{reveal ? value : value.replace(/:\/\/([^:]+):[^@]+@/, "://$1:••••••••@")}</span>
        <CopyButton value={value} className="h-6 w-6" label="" />
      </div>
    </div>
  );
}

function ConnectionDialog({ d, onClose }: { d: DatabaseDTO; onClose: () => void }) {
  const [c, setC] = useState<Creds | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    api<Creds>(`/api/v1/databases/${d.id}/credentials`)
      .then(setC)
      .catch((e) => setErr(e instanceof ApiClientError ? e.message : "Failed"));
  }, [d.id]);
  return (
    <Dialog open onClose={onClose} title={`Connect to ${d.name}`} description="Credentials are encrypted at rest. Viewing them is recorded in the audit log." size="lg">
      {err ? (
        <p className="text-sm text-danger">{err}</p>
      ) : !c ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" leftIcon={reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} onClick={() => setReveal((r) => !r)}>
              {reveal ? "Hide" : "Reveal"}
            </Button>
          </div>
          <Secret label={`Internal URL (${c.envNames.join(" / ")})`} value={c.internalUrl} reveal={reveal} />
          {c.publicUrl && <Secret label="Public URL" value={c.publicUrl} reveal={reveal} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Secret label="Host" value={`${c.host}:${c.port}`} reveal />
            <Secret label="Database" value={c.database} reveal />
            <Secret label="User" value={c.user} reveal />
            <Secret label="Password" value={reveal ? c.password : "••••••••••••"} reveal />
          </div>
        </div>
      )}
    </Dialog>
  );
}

function BackupsDialog({ d, canEdit, onClose }: { d: DatabaseDTO; canEdit: boolean; onClose: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<BackupDTO[] | null>(null);
  const [confirm, setConfirm] = useState<BackupDTO | null>(null);
  const load = async () => {
    try {
      setItems((await api<{ items: BackupDTO[] }>(`/api/v1/databases/${d.id}/backups`)).items);
    } catch {}
  };
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (e) {
      toast.error("Action failed", e instanceof ApiClientError ? e.message : undefined);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Backups — ${d.name}`} description={`${d.backupSchedule ? `Schedule ${d.backupSchedule} (UTC)` : "No schedule"} · keeps the last ${d.backupRetention}`} size="lg">
      <div className="space-y-3">
        {canEdit && (
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" leftIcon={<Archive className="h-3.5 w-3.5" />} onClick={() => run(() => api(`/api/v1/databases/${d.id}/backups`, { method: "POST" }), "Backup started")}>
              Back up now
            </Button>
          </div>
        )}
        {!items ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !items.length ? (
          <p className="py-6 text-center text-[13px] text-muted">No backups yet.</p>
        ) : (
          <div className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-md border border-border">
            {items.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[13px]">
                    <Badge tone={b.status === "SUCCESS" ? "success" : b.status === "FAILED" ? "danger" : "warning"}>{b.status.toLowerCase()}</Badge>
                    <span>{new Date(b.createdAt).toLocaleString()}</span>
                    <span className="text-subtle">{b.trigger === "SCHEDULED" ? "scheduled" : "manual"}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[12px] text-subtle">
                    {b.fileName ?? b.error ?? "…"} {b.sizeBytes ? `· ${formatBytes(b.sizeBytes)}` : ""}
                  </div>
                </div>
                {canEdit && b.status === "SUCCESS" && (
                  <div className="flex items-center gap-1">
                    <a href={`/api/v1/databases/${d.id}/backups/${b.id}/download`} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] hover:bg-surface-2">
                      <Download className="h-3.5 w-3.5" /> Download
                    </a>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(b)}>
                      Restore
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Delete backup" onClick={() => run(() => api(`/api/v1/databases/${d.id}/backups/${b.id}`, { method: "DELETE" }), "Backup deleted")}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Restore backup?"
        description={confirm ? `The current data of ${d.name} is overwritten with the backup from ${new Date(confirm.createdAt).toLocaleString()}.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const b = confirm!;
                setConfirm(null);
                await run(() => api(`/api/v1/databases/${d.id}/backups/${b.id}/restore`, { method: "POST" }), "Restore started");
              }}
            >
              Restore
            </Button>
          </>
        }
      />
    </Dialog>
  );
}

function SettingsDialog({ d, onClose, onSaved }: { d: DatabaseDTO; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [schedule, setSchedule] = useState(d.backupSchedule ?? "");
  const [retention, setRetention] = useState(String(d.backupRetention));
  const [pub, setPub] = useState(!!d.publicPort);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/databases/${d.id}`, { method: "PATCH", body: { backupSchedule: schedule || null, backupRetention: Number(retention), publicAccess: pub } });
      toast.success("Settings saved", pub !== !!d.publicPort ? "The container restarts to apply public access." : undefined);
      onSaved();
    } catch (e) {
      toast.error("Could not save", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${d.name} settings`}
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
      <div className="space-y-4">
        <Field label="Backup schedule (cron, UTC)" htmlFor="s-sched" hint="Empty = manual backups only">
          <Input id="s-sched" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 3 * * *" className="font-mono" />
        </Field>
        <Field label="Keep the last N backups" htmlFor="s-ret">
          <Input id="s-ret" type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </Field>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-sm">
          <span>Public access {d.publicPort && <span className="font-mono text-muted">(port {d.publicPort})</span>}</span>
          <Switch checked={pub} onCheckedChange={setPub} />
        </label>
      </div>
    </Dialog>
  );
}
