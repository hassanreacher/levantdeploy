"use client";

import { useEffect, useState } from "react";
import { DatabaseBackup, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CodeBlock } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog } from "@/components/ui/dialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { api } from "@/lib/client/api";
import { formatBytes, timeAgo } from "@/lib/utils";
import type { BackupFile, BackupStatus } from "@/lib/ops/backup";
import { errText, usePlatformPatch } from "../save-helper";

type Config = { enabled: boolean; schedule: string; keep: number };

const PRESETS = [
  { label: "Daily 03:23", value: "23 3 * * *" },
  { label: "Every 6 hours", value: "7 */6 * * *" },
  { label: "Weekly (Sun)", value: "23 3 * * 0" },
];

export function BackupsSettings(props: { items: BackupFile[]; last: BackupStatus | null; running: boolean; config: Config; dir: string; installDir: string }) {
  const { busy, setBusy, patch, toast, router } = usePlatformPatch();
  const { items, last, config } = props;
  const [enabled, setEnabled] = useState(config.enabled);
  const [schedule, setSchedule] = useState(config.schedule);
  const [keep, setKeep] = useState(String(config.keep));
  const [running, setRunning] = useState(props.running);
  const [confirm, setConfirm] = useState<string | null>(null);

  // poll while a backup is running
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const r = await api<{ running: boolean }>("/api/v1/platform/backups").catch(() => null);
      if (r && !r.running) {
        setRunning(false);
        router.refresh();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [running, router]);

  const runNow = async () => {
    setBusy("run");
    try {
      await api("/api/v1/platform/backups", { method: "POST" });
      setRunning(true);
      toast.info("Backup started", "The worker is dumping the control database…");
    } catch (e) {
      toast.error("Could not start the backup", errText(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (name: string) => {
    setBusy(`rm:${name}`);
    try {
      await api(`/api/v1/platform/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast.success("Backup deleted");
      setConfirm(null);
      router.refresh();
    } catch (e) {
      toast.error("Could not delete", errText(e));
    } finally {
      setBusy(null);
    }
  };

  const dirty = enabled !== config.enabled || schedule !== config.schedule || Number(keep) !== config.keep;

  return (
    <>
      <Card>
        <CardHeader
          title="Control Database Backups"
          description="Scheduled pg_dump of the LevantDeploy database (projects, deployments, encrypted env vars, domains, users)."
          actions={
            <Button size="sm" variant="secondary" leftIcon={<DatabaseBackup className="h-3.5 w-3.5" />} loading={busy === "run" || running} onClick={runNow}>
              {running ? "Backing up…" : "Back up now"}
            </Button>
          }
        />
        <CardBody className="space-y-5">
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} label="Scheduled backups" />
            Scheduled backups
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Schedule (cron, UTC)" htmlFor="cron" hint="minute hour day month weekday">
              <Input id="cron" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" disabled={!enabled} />
            </Field>
            <Field label="Keep" htmlFor="keep" hint="Older backups are deleted automatically.">
              <Input id="keep" type="number" min={1} max={365} value={keep} onChange={(e) => setKeep(e.target.value)} suffix="backups" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                disabled={!enabled}
                onClick={() => setSchedule(p.value)}
                className="rounded-full border border-border px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50"
              >
                {p.label}
              </button>
            ))}
          </div>
        </CardBody>
        <CardFooter
          hint={
            last ? (
              <span className="inline-flex items-center gap-2">
                Last run {timeAgo(last.at)} <Badge tone={last.ok ? "success" : "danger"}>{last.ok ? "OK" : "Failed"}</Badge>
                {!last.ok && last.error && <span className="truncate text-danger">{last.error.slice(0, 80)}</span>}
              </span>
            ) : (
              "No backup has run yet."
            )
          }
        >
          <Button size="sm" variant="primary" disabled={!dirty} loading={busy === "cfg"} onClick={() => patch("cfg", { backups: { enabled, schedule: schedule.trim(), keep: Number(keep) } })}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Backup Files" description={<span className="font-mono text-[12px]">{props.dir}</span>} />
        <CardBody>
          {items.length === 0 ? (
            <EmptyState icon={<DatabaseBackup className="h-5 w-5" />} title="No backups yet" description="Run a backup now or wait for the schedule." />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <THead>
                  <TR>
                    <TH>File</TH>
                    <TH>Size</TH>
                    <TH className="hidden sm:table-cell">Created</TH>
                    <TH className="w-24 text-right">
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((b) => (
                    <TR key={b.name}>
                      <TD className="font-mono text-[13px]">{b.name}</TD>
                      <TD className="text-[13px]">{formatBytes(b.size)}</TD>
                      <TD className="hidden text-[13px] text-muted sm:table-cell">{timeAgo(b.createdAt)}</TD>
                      <TD className="text-right">
                        <span className="inline-flex gap-1">
                          <a
                            href={`/api/v1/platform/backups/${encodeURIComponent(b.name)}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                            aria-label={`Download ${b.name}`}
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          <button
                            type="button"
                            onClick={() => setConfirm(b.name)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                            aria-label={`Delete ${b.name}`}
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Full Server Backup & Restore" description="The database dump above does not include build caches, uploads or app volumes. For a full backup run the backup script on the server." />
        <CardBody className="space-y-3">
          <CodeBlock title="Full backup (database + storage, rotated)" prompt wrap code={`sudo ${props.installDir}/install/backup.sh`} />
          <CodeBlock title="Restore a backup" prompt wrap code={`sudo ${props.installDir}/install/restore.sh ${props.dir}/${items[0]?.name ?? "levantdeploy-YYYYMMDD-HHMMSS.dump"}`} />
        </CardBody>
      </Card>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Delete backup?"
        description={confirm ?? ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy === `rm:${confirm}`} onClick={() => confirm && remove(confirm)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">This file will be removed from the server. This cannot be undone.</p>
      </Dialog>
    </>
  );
}
