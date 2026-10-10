"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, CircleSlash, Clock, Globe, MoreHorizontal, Play, Plus, Terminal, XCircle } from "lucide-react";
import { Badge, Button, Card, CodeBlock, Dialog, Dropdown, DropdownItem, DropdownSeparator, EmptyState, Field, Input, Select, Spinner, Switch, Tabs, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDuration, timeAgo } from "@/lib/utils";
import type { CronDTO } from "@/lib/runtime/cron-api";

type Run = { id: string; status: "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED"; trigger: string; exitCode: number | null; output: string | null; startedAt: string; finishedAt: string | null; durationMs: number | null };

const PRESETS = [
  { value: "*/5 * * * *", label: "Every 5 minutes" },
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 0 * * *", label: "Every day at 00:00" },
  { value: "0 9 * * 1-5", label: "Weekdays at 09:00" },
  { value: "0 0 * * 0", label: "Every Sunday" },
  { value: "custom", label: "Custom…" },
];

function RunStatus({ s }: { s: Run["status"] | null }) {
  if (!s) return <span className="text-[13px] text-subtle">Never run</span>;
  if (s === "SUCCESS") return <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>Success</Badge>;
  if (s === "FAILED") return <Badge tone="danger" icon={<XCircle className="h-3 w-3" />}>Failed</Badge>;
  if (s === "SKIPPED") return <Badge tone="neutral" icon={<CircleSlash className="h-3 w-3" />}>Skipped</Badge>;
  return <Badge tone="warning" icon={<Spinner className="h-3 w-3" />}>Running</Badge>;
}

export function CronClient({ projectId, canEdit, initial, hasProduction }: { projectId: string; canEdit: boolean; initial: CronDTO[]; hasProduction: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [jobs, setJobs] = useState(initial);
  const [editing, setEditing] = useState<CronDTO | "new" | null>(null);
  const [history, setHistory] = useState<CronDTO | null>(null);
  useEffect(() => setJobs(initial), [initial]);

  const reload = async () => {
    try {
      setJobs((await api<{ items: CronDTO[] }>(`/api/v1/projects/${projectId}/cron`)).items);
    } catch {}
  };
  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runNow = async (j: CronDTO) => {
    try {
      await api(`/api/v1/projects/${projectId}/cron/${j.id}/run`, { method: "POST" });
      toast.success(`${j.name} started`);
      setHistory(j);
    } catch (e) {
      toast.error("Could not start the job", e instanceof ApiClientError ? e.message : undefined);
    }
  };
  const toggle = async (j: CronDTO, enabled: boolean) => {
    setJobs((js) => js.map((x) => (x.id === j.id ? { ...x, enabled } : x)));
    try {
      await api(`/api/v1/projects/${projectId}/cron/${j.id}`, { method: "PATCH", body: { enabled } });
      await reload();
    } catch (e) {
      toast.error("Update failed", e instanceof ApiClientError ? e.message : undefined);
      await reload();
    }
  };
  const remove = async (j: CronDTO) => {
    try {
      await api(`/api/v1/projects/${projectId}/cron/${j.id}`, { method: "DELETE" });
      toast.success(`Deleted ${j.name}`);
      await reload();
      router.refresh();
    } catch (e) {
      toast.error("Delete failed", e instanceof ApiClientError ? e.message : undefined);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{hasProduction ? "Jobs run against the current production deployment (its image, env vars and volumes)." : "Jobs start running once the project has a production deployment."}</p>
        {canEdit && (
          <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>
            New cron job
          </Button>
        )}
      </div>

      {jobs.length ? (
        <Card className="divide-y divide-border">
          {jobs.map((j) => (
            <div key={j.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{j.name}</span>
                  <code className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[12px]">{j.schedule}</code>
                  <span className="text-[13px] text-muted">
                    {j.description}
                    {j.timezone !== "UTC" ? ` (${j.timezone})` : " UTC"}
                  </span>
                  {!j.enabled && <Badge tone="neutral">Paused</Badge>}
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
                  {j.command ? <Terminal className="h-3.5 w-3.5 shrink-0" /> : <Globe className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate font-mono">{j.command ?? `GET ${j.path}`}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
                  <RunStatus s={j.lastStatus} />
                  {j.lastRunAt && (
                    <span className="inline-flex items-center gap-1" suppressHydrationWarning>
                      <Clock className="h-3 w-3" /> {timeAgo(j.lastRunAt)}
                      {j.lastDurationMs !== null && ` · ${formatDuration(j.lastDurationMs)}`}
                    </span>
                  )}
                  {j.enabled && j.nextRunAt && (
                    <span className="inline-flex items-center gap-1" suppressHydrationWarning>
                      <CalendarClock className="h-3 w-3" /> next {new Date(j.nextRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setHistory(j)}>
                  History
                </Button>
                {canEdit && (
                  <>
                    <Button size="sm" variant="secondary" leftIcon={<Play className="h-3.5 w-3.5" />} onClick={() => runNow(j)} disabled={!hasProduction}>
                      Run
                    </Button>
                    <Switch checked={j.enabled} onCheckedChange={(v) => toggle(j, v)} size="sm" />
                    <Dropdown
                      align="end"
                      trigger={() => (
                        <span role="button" aria-label="Job actions" className="inline-flex rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
                          <MoreHorizontal className="h-4 w-4" />
                        </span>
                      )}
                    >
                      {(close) => (
                        <>
                          <DropdownItem onClick={() => (close(), setEditing(j))}>Edit</DropdownItem>
                          <DropdownSeparator />
                          <DropdownItem danger onClick={() => (close(), remove(j))}>
                            Delete
                          </DropdownItem>
                        </>
                      )}
                    </Dropdown>
                  </>
                )}
              </div>
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={<CalendarClock className="h-5 w-5" />}
          title="No cron jobs"
          description="Run maintenance commands (php artisan schedule:run, python manage.py clearsessions…) or ping an endpoint on a schedule."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => setEditing("new")}>
                New cron job
              </Button>
            ) : undefined
          }
        />
      )}

      {editing && (
        <JobDialog
          projectId={projectId}
          job={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {history && <HistoryDialog projectId={projectId} job={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function JobDialog({ projectId, job, onClose, onSaved }: { projectId: string; job: CronDTO | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(job?.name ?? "");
  const [type, setType] = useState<"command" | "path">(job?.path ? "path" : "command");
  const [target, setTarget] = useState(job?.command ?? job?.path ?? "");
  const initialPreset = PRESETS.find((p) => p.value === job?.schedule)?.value ?? (job ? "custom" : "0 * * * *");
  const [preset, setPreset] = useState(initialPreset);
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 * * * *");
  const [tz, setTz] = useState(job?.timezone ?? "UTC");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const save = async () => {
    setBusy(true);
    setFields({});
    const body = { name, schedule, timezone: tz, command: type === "command" ? target : null, path: type === "path" ? target : null };
    try {
      if (job) await api(`/api/v1/projects/${projectId}/cron/${job.id}`, { method: "PATCH", body });
      else await api(`/api/v1/projects/${projectId}/cron`, { body });
      toast.success(job ? "Cron job updated" : "Cron job created");
      onSaved();
    } catch (e) {
      if (e instanceof ApiClientError) {
        setFields(e.fields ?? {});
        if (!e.fields) toast.error("Could not save", e.message);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={job ? "Edit cron job" : "New cron job"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!name || !target}>
            {job ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="cj-name" error={fields.name}>
          <Input id="cj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-cleanup" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_140px]">
          <Field label="Schedule" htmlFor="cj-preset">
            <Select
              id="cj-preset"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value);
                if (e.target.value !== "custom") setSchedule(e.target.value);
              }}
              options={PRESETS}
            />
          </Field>
          <Field label="Cron expression" htmlFor="cj-expr" error={fields.schedule} hint="min hour day month weekday">
            <Input id="cj-expr" value={schedule} onChange={(e) => (setSchedule(e.target.value), setPreset("custom"))} className="font-mono" />
          </Field>
          <Field label="Timezone" htmlFor="cj-tz" error={fields.timezone}>
            <Input id="cj-tz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="UTC" />
          </Field>
        </div>
        <Tabs<"command" | "path">
          tabs={[
            { value: "command", label: "Run a command" },
            { value: "path", label: "Call a path" },
          ]}
          value={type}
          onValueChange={setType}
        />
        {type === "command" ? (
          <Field label="Command" htmlFor="cj-cmd" error={fields.command} hint="Runs with sh -c in a fresh container of the production image (same env vars and volumes).">
            <Input id="cj-cmd" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="node scripts/cleanup.js" className="font-mono" />
          </Field>
        ) : (
          <Field label="Path" htmlFor="cj-path" error={fields.path ?? fields.command} hint="HTTP GET on the production app. 2xx/3xx = success.">
            <Input id="cj-path" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/api/cron/digest" className="font-mono" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function HistoryDialog({ projectId, job, onClose }: { projectId: string; job: CronDTO; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await api<{ items: Run[] }>(`/api/v1/projects/${projectId}/cron/${job.id}/runs?limit=30`);
        if (!stop) {
          setRuns(r.items);
          setOpen((o) => o ?? r.items[0]?.id ?? null);
        }
      } catch {}
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectId, job.id]);
  return (
    <Dialog open onClose={onClose} title={`${job.name} — history`} description={job.command ?? `GET ${job.path}`} size="lg">
      {!runs ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !runs.length ? (
        <p className="py-6 text-center text-[13px] text-muted">No runs yet.</p>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {runs.map((r) => (
            <div key={r.id} className="rounded-md border border-border">
              <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <span className="flex items-center gap-2">
                  <RunStatus s={r.status} />
                  <span className="text-[13px]">{new Date(r.startedAt).toLocaleString()}</span>
                  <Badge tone="outline">{r.trigger === "MANUAL" ? "Manual" : "Scheduled"}</Badge>
                </span>
                <span className="text-[12px] text-subtle">
                  {r.exitCode !== null && `${job.path ? "HTTP" : "exit"} ${r.exitCode} · `}
                  {r.durationMs !== null ? formatDuration(r.durationMs) : "…"}
                </span>
              </button>
              {open === r.id && <CodeBlock code={r.output || "(no output)"} wrap className="rounded-none border-0 border-t border-border" />}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
